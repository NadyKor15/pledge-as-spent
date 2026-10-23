import { clientIp, readFields, respond, withService } from "@/server/http";

/** A fresh demo drive with three donor holds and the company match (sandbox test card). At most 5 an hour per IP. */
export async function POST(req: Request) {
  return withService(async (svc) => {
    const fields = await readFields(req);
    const view = await svc.createDemoDrive({ ip: clientIp(req) });
    if (fields.back !== undefined) return respond({ back: `/debug/drive/${view.drive.id}` }, view);
    return Response.json(view, { status: 201 });
  });
}
