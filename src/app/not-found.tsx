import { Failure } from "@/ui/states";

export default function NotFound() {
  return <Failure title="No such page" message="This address does not lead anywhere in the demo." />;
}
