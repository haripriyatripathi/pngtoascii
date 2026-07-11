import { createFileRoute } from "@tanstack/react-router";
import { PngtoAscii } from "@/components/asciify/PngtoAscii";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return <PngtoAscii />;
}
