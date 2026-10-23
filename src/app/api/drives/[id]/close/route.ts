import { readFields, respond, withService } from "@/server/http";

/** Close the drive: captures first, then each hold's remainder is voided once its captures are confirmed. */
export async function POST(req: Request, ctx: RouteContext<"/api/drives/[id]/close">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    const commands = await svc.closeDrive(id);
    return respond(f, { commands, drive: (await svc.getDriveView(id)).drive });
  });
}
