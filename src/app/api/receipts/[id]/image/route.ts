import { isClosedCopy } from "@/receipts/close";
import { withService } from "@/server/http";

/**
 * The published copy of a receipt photo: closed to its purchase lines, everything else a smooth background. Only bytes
 * that carry the closing mark are served; the original, and any copy stored before closing, never are.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/receipts/[id]/image">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const img = await svc.getReceiptImage(id);
    if (!img || !isClosedCopy(img.bytes)) {
      return Response.json({ error: "not_published", message: "Only the purchase lines of a receipt are ever shown, and this photo has no copy closed to them, so it is not published." }, { status: 404 });
    }
    return new Response(Buffer.from(img.bytes), { headers: { "content-type": img.mediaType, "cache-control": "private, max-age=300" } });
  });
}
