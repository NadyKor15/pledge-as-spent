import { clientIp, readFields, respond, sampleBytes, str, withService } from "@/server/http";
import type { Channel } from "@/server/service";
import { ServiceError } from "@/server/errors";

/**
 * Upload a receipt photo: multipart field `image` (or `file`), or `sample=hero`
 * for the cached sample receipt. Optional `channel`: web | whatsapp | telegram.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/drives/[id]/receipts">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > svc.limits.maxImageBytes + 64 * 1024) {
      throw new ServiceError(413, "too_large", `The upload is ${(declared / 1048576).toFixed(1)} MB; the limit is ${svc.limits.maxImageBytes / 1048576} MB.`);
    }
    const f = await readFields(req);
    const file = f.image ?? f.file;
    const sample = str(f.sample);
    let bytes: Uint8Array;
    if (sample) bytes = await sampleBytes(sample);
    else if (file instanceof Blob) bytes = new Uint8Array(await file.arrayBuffer());
    else throw new ServiceError(400, "no_image", "Send the photo as multipart field `image`, or `sample=hero` for the sample receipt.");
    const result = await svc.submitReceipt({ driveId: id, bytes, channel: (str(f.channel) ?? "web") as Channel, ip: clientIp(req) });
    return respond(f, result, 201);
  });
}
