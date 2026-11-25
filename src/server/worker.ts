import { randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import { appOrigin, hosted } from './config';
import { database } from './db';
import { event, readProof, snapshotHash, type Job, type ProductionFile } from './orders';
import { artworkImages, renderPdf, renderPng } from './render';
import { sha256, writeObject } from './storage';

const bundleLimit = 24 * 1024 * 1024;
const leaseDuration = "interval '120 seconds'";
type Claim = Job & { lease_token: string; number: string; product_id: string; paid_at: Date };

async function claimJob() {
  const db = await database();
  await db.query(`update printshop.jobs set status='failed', error='Interrupted after three attempts.',updated_at=now()
    where status='running' and lease_until < now() and attempts>=3`);
  const [job] = await db.query<Claim>(
    `with chosen as (
       select j.id,o.number,o.product_id,o.paid_at from printshop.jobs j
       join printshop.orders o on o.id=j.order_id and o.paid_proof_id=j.proof_id and o.current_proof_id=j.proof_id
       where o.proof_state='approved' and o.paid_at is not null and not o.payment_review
         and (j.status='queued' or (j.status='running' and j.lease_until < now() and j.attempts < 3))
       order by j.created_at limit 1 for update of j skip locked
     )
     update printshop.jobs j set status='running',lease_token=$1,lease_until=now()+${leaseDuration},attempts=attempts+1,
        processed_rows=0,updated_at=now(),error=null
     from chosen where j.id=chosen.id returning j.*,chosen.number,chosen.product_id,chosen.paid_at`, [randomUUID()]);
  return job;
}

async function build(job: Claim) {
  const db = await database();
  const proof = await readProof(db, job.order_id, job.proof_id);
  const snapshot = proof.snapshot;
  if (proof.hash_format === 'canonical-v1' && snapshotHash(snapshot) !== proof.sha256) {
    throw new Error('The proof failed its snapshot integrity check.');
  }
  const images = await artworkImages(snapshot);
  const label = `DH${job.number}`;
  const date = new Date(job.paid_at).toISOString().slice(0, 10).replaceAll('-', '');
  const stem = `${label}_${job.product_id}_${date}`;
  const prefix = `${label}/${job.product_id}/v${proof.version}/${job.lease_token}`;
  const manifest: ProductionFile[] = [];
  let zipped: Record<string, Uint8Array> = {};
  let totalBytes = 0;
  let archiveParts = 0;
  const write = async (filename: string, row_number: number, format: ProductionFile['format'], bytes: Uint8Array) => {
    const object_key = `${prefix}/${filename}`;
    const contentType = format === 'png' ? 'image/png' : format === 'pdf' ? 'application/pdf' : 'application/zip';
    await writeObject(object_key, bytes, contentType);
    manifest.push({ row_number, format, object_key, filename, sha256: sha256(bytes), size_bytes: bytes.byteLength });
  };
  const finishArchive = async (last: boolean) => {
    if (!totalBytes) return;
    const part = last && archiveParts === 0 ? '' : `_Part${String(archiveParts + 1).padStart(4, '0')}`;
    await write(`${stem}_Batch${part}.zip`, archiveParts++, 'zip', zipSync(zipped, { level: 0 }));
    totalBytes = 0;
    zipped = {};
  };
  const addFile = async (filename: string, row: number, format: 'pdf' | 'png', bytes: Uint8Array) => {
    await write(filename, row, format, bytes);
    if (totalBytes + bytes.byteLength > bundleLimit) await finishArchive(false);
    totalBytes += bytes.byteLength;
    zipped[filename] = bytes;
  };
  for (let row = 0; row < job.expected_rows; row++) {
    const basename = `${stem}_${snapshot.runners.length ? `Row${String(row + 1).padStart(4, '0')}` : 'Artwork'}`;
    const png = await renderPng(snapshot, row, images);
    const pdf = await renderPdf(snapshot, png, basename);
    await addFile(`${basename}.png`, row + 1, 'png', png);
    await addFile(`${basename}.pdf`, row + 1, 'pdf', pdf);
    const [lease] = await db.query<{ id: string }>(`update printshop.jobs set processed_rows=$3,lease_until=now()+${leaseDuration},updated_at=now()
      where id=$1 and lease_token=$2 and status='running' and lease_until > now() returning id`, [job.id, job.lease_token, row + 1]);
    if (!lease) throw new Error('Worker lease was superseded.');
  }
  await finishArchive(true);
  if (manifest.filter(({ format }) => format !== 'zip').length !== job.expected_rows * 2) {
    throw new Error('Incomplete output manifest.');
  }
  await db.transaction(async (tx) => {
    const [ready] = await tx.query<{ id: string }>(`update printshop.jobs set status='ready', lease_token=null, lease_until=null,updated_at=now()
      where id=$1 and lease_token=$2 and status='running' and lease_until>now() and expected_rows=processed_rows returning id`,
    [job.id, job.lease_token]);
    if (!ready) return;
    await tx.query(`insert into printshop.manifest (job_id,order_id,proof_id,row_number,format,object_key,filename,sha256,size_bytes)
      select $1,$2,$3,row_number,format,object_key,filename,sha256,size_bytes
      from jsonb_to_recordset($4::jsonb) as files(row_number int,format text,object_key text,filename text,sha256 text,size_bytes int)`,
    [job.id, job.order_id, job.proof_id, JSON.stringify(manifest)]);
    await event(tx, job.order_id, 'generation_ready', { proof: job.proof_id });
  });
}

export async function runGeneration() {
  const job = await claimJob();
  if (!job) return false;
  try {
    await build(job);
  } catch (error) {
    console.error('Print generation failed', job.id, error instanceof Error ? error.message : 'Unknown failure');
    const db = await database();
    await db.transaction(async (tx) => {
      const [failed] = await tx.query<{ id: string }>(
        `update printshop.jobs set status='failed',error=$3,lease_token=null,lease_until=null,updated_at=now()
         where id=$1 and lease_token=$2 and status='running' returning id`,
      [job.id, job.lease_token, `Could not render or store row ${Math.min(job.expected_rows, (await tx.query<{ processed_rows: number }>(
        'select processed_rows from printshop.jobs where id=$1', [job.id]))[0].processed_rows + 1)}. Retry to rebuild this approval.`]);
      if (failed) await event(tx, job.order_id, 'generation_failed', { proof: job.proof_id });
    });
  }
  return true;
}

const emailTitles: Record<string, string> = {
  order_created: 'Order received',
  proof_published: 'A proof is ready',
  proof_approved: 'Proof approved',
  production_started: 'Production started',
  order_completed: 'Order completed',
};

export async function runEmail() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!hosted() || !apiKey || !from) return false;
  const db = await database();
  const [notification] = await db.query<{
    id: string; recipient: string; event_type: string; order_id: string; number: string; attempts: number;
  }>(`with target as (
    select n.id,e.event_type,e.order_id,o.number from printshop.notifications n
      join printshop.order_events e on e.id=n.event_id join printshop.orders o on o.id=e.order_id
    where n.status in ('pending','sending') and n.next_attempt_at<=now()
    order by n.next_attempt_at limit 1 for update of n skip locked
  )
  update printshop.notifications n set status='sending',next_attempt_at=now()+interval '3 minutes',attempts=n.attempts+1
    from target where n.id=target.id returning n.id,n.recipient,n.attempts,target.event_type,target.order_id,target.number`);
  if (!notification) return false;
  try {
    const subject = `DH${notification.number} · ${emailTitles[notification.event_type] ?? 'Order update'}`;
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(12000),
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': notification.id },
      body: JSON.stringify({ from, to: [notification.recipient], subject,
        text: `${subject}\n\nSee your order at ${appOrigin()}/orders/${notification.order_id}` }),
    });
    if (!response.ok) throw new Error(`Email provider status ${response.status}`);
    await db.query("update printshop.notifications set status='sent',sent_at=now(),last_error=null where id=$1 and attempts=$2",
      [notification.id, notification.attempts]);
  } catch {
    await db.query(`update printshop.notifications set status=$3,next_attempt_at=now()+interval '3 minutes',last_error='Delivery failed'
      where id=$1 and attempts=$2`, [notification.id, notification.attempts, notification.attempts >= 4 ? 'failed' : 'pending']);
  }
  return true;
}

const demoState = globalThis as typeof globalThis & { dhDemoWorker?: NodeJS.Timeout; dhDemoWorkerBusy?: boolean };

export function startDemoWorker() {
  if (hosted() || demoState.dhDemoWorker) return;
  demoState.dhDemoWorker = setInterval(async () => {
    if (demoState.dhDemoWorkerBusy) return;
    demoState.dhDemoWorkerBusy = true;
    try {
      await runGeneration();
    } catch {
      console.error('Local print worker could not poll its queue.');
    } finally {
      demoState.dhDemoWorkerBusy = false;
    }
  }, 1500).unref();
}
