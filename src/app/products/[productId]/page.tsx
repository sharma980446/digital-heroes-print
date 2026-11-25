import { ConfigureScreen } from '@/web/store';

export default async function Page({ params }: { params: Promise<{ productId: string }> }) {
  return <ConfigureScreen productId={(await params).productId} />;
}
