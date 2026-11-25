import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ORDER_CURRENCY, money, PrintError, taxName, type OrderCurrency } from '@/domain/catalogue';
import type { Account } from './auth';
import { database } from './db';
import { currentJob, productionUnlocked, readOrder, type ProductionFile } from './orders';

export async function productionFile(account: Account, orderId: string, row: number, fmt: ProductionFile['format']) {
  if (account.role !== 'staff') throw new PrintError('Staff access is required.', 403);
  const db = await database();
  const order = await readOrder(db, account, orderId);
  const job = await currentJob(db, orderId);
  if (!productionUnlocked(order, job)) throw new PrintError('Production files are locked.', 409);
  const [file] = await db.query<ProductionFile>(
    'select * from printshop.manifest where job_id=$1 and row_number=$2 and format=$3', [job!.id, row, fmt]);
  if (!file) throw new PrintError('File not found.', 404);
  return file;
}

export async function receipt(account: Account, orderId: string) {
  const db = await database();
  const order = await readOrder(db, account, orderId);
  const [paid] = await db.query<{ reference: string; provider: string; paid_at: Date }>(
    "select reference,provider,paid_at from printshop.payments where order_id=$1 and status='applied'", [orderId]);
  if (!paid) throw new PrintError('A receipt is available after payment.', 409);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595.28, 420]);
  const label = `DH${order.number}`;
  pdf.setTitle(`Receipt ${label}`);
  const text = (value: string, x: number, y: number, size: number, heavy = false) => page.drawText(
    value.replace(/[^\x20-\x7e\xa0-\xff]/g, '?'), { x, y, size, font: heavy ? bold : font, color: rgb(.12, .19, .17) });
  const { price, config } = order;
  text('DIGITAL HEROES PRINT', 45, 365, 12, true);
  text(`Receipt ${label}`, 45, 320, 27, true);
  text(`${new Date(paid.paid_at).toISOString().slice(0, 10)}   |   ${price.currency}   |   ${paid.provider === 'demo' ? 'Local test payment' : 'Stripe test payment'}`, 45, 294, 11);
  text(order.product_snapshot.title, 45, 259, 14, true);
  text(`${config.quantity} units   |   ${config.width} x ${config.height} mm   |   ${price.material}`, 45, 239, 11);
  const charges = [
    ['Before discount', price.beforeDiscount], ['Discount', -price.discount],
    ['Net subtotal', price.subtotal], [taxName(price.currency), price.tax], ['Total', price.total],
  ] as const;
  for (const [index, [name, value]] of charges.entries()) {
    text(name, 45, 201 - 23 * index, 12, name === 'Total');
    const amount = price.currency === ORDER_CURRENCY ? `INR ${(value / 100).toFixed(2)}` : money(value, price.currency);
    text(amount, 260, 201 - 23 * index, 12, name === 'Total');
  }
  text(`Transaction ${paid.reference}`, 45, 55, 10);
  return { filename: `${label}_Receipt.pdf`, bytes: await pdf.save() };
}

export async function reports(from?: string, to?: string) {
  return (await database()).query<{ family: string; currency: OrderCurrency; orders: number; revenue: number; completed: number; units: number }>(
    `with metrics as (
      select product_id as family, price->>'currency' as currency, created_at as effective_date,
        1 as orders, 0 as revenue, 0 as completed, 0 as units from printshop.orders
      union all select o.product_id,p.currency::text,p.paid_at,0,p.amount,0,0 from printshop.payments p join printshop.orders o on o.id=p.order_id where p.status='applied'
      union all select product_id,price->>'currency',completed_at,0,0,1,(config->>'quantity')::int from printshop.orders where completed_at is not null
    )
    select family,currency,sum(orders)::float8 as orders,sum(revenue)::float8 as revenue,sum(completed)::float8 as completed,sum(units)::float8 as units
    from metrics where ($1::date is null or effective_date>=($1::date::timestamp at time zone 'UTC'))
       and ($2::date is null or effective_date<(($2::date+1)::timestamp at time zone 'UTC'))
    group by family,currency order by family,currency`, [from ?? null, to ?? null]);
}

export async function accountingCsv() {
  const rows = await (await database()).query<{ number: string; owner_id: string; paid_at: Date; title: string; quantity: number;
    subtotal: number; discount: number; tax: number; gross: number; currency: string; reference: string }>(`
    select o.number,o.owner_id,p.paid_at,o.product_snapshot->>'title' as title,(o.config->>'quantity')::int as quantity,
      (o.price->>'subtotal')::int as subtotal,(o.price->>'discount')::int as discount,(o.price->>'tax')::int as tax,
      p.amount as gross,p.currency,p.reference from printshop.payments p join printshop.orders o on p.order_id=o.id
    where p.status='applied' order by p.paid_at,o.number`);
  const csvCell = (input: string | number) => {
    const raw = String(input);
    const safe = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return ['InvoiceNumber,CustomerReference,PaymentDate,Description,Quantity,Net,Discount,Tax,Gross,Currency,PaymentReference',
    ...rows.map((r) => [`DH${r.number}`, r.owner_id, new Date(r.paid_at).toISOString(), r.title, r.quantity,
      (r.subtotal / 100).toFixed(2), (r.discount / 100).toFixed(2), (r.tax / 100).toFixed(2), (r.gross / 100).toFixed(2),
      r.currency, r.reference].map(csvCell).join(','))].join('\r\n');
}
