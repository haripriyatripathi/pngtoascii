import { createFileRoute } from "@tanstack/react-router";
import { AsciifyApp } from "@/components/asciify/AsciifyApp";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return <AsciifyApp />;
}
