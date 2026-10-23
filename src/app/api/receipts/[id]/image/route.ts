import { withService } from "@/server/http";

/** The published copy of a receipt photo: personal data blurred. The original is never served. */
export async function GET(_req: Request, ctx: RouteContext<"/api/receipts/[id]/image">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const img = await svc.getReceiptImage(id);
    if (!img) return Response.json({ error: "not_published", message: "Personal data on this receipt could not be blurred, so the image is not published." }, { status: 404 });
    return new Response(Buffer.from(img.bytes), { headers: { "content-type": img.mediaType, "cache-control": "private, max-age=300" } });
  });
}
