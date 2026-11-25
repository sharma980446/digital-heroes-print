import { notFound } from 'next/navigation';
import { z } from 'zod';
import { OrderScreen } from '@/web/order';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  return <OrderScreen key={id} id={id} />;
}
