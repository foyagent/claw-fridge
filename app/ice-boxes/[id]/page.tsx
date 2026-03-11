import { IceBoxDetail } from "@/components/ice-boxes/ice-box-detail";

export default async function IceBoxDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="fridge-page">
      <div className="fridge-shell">
        <IceBoxDetail id={id} />
      </div>
    </main>
  );
}
