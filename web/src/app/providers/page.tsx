import type { Metadata } from "next";
import { ProvidersView } from "@/components/pages/providers/ProvidersView";

export const metadata: Metadata = {
  title: "Providers · Relay",
  description:
    "Live provider status: configured adapters, endpoints, models and the model-prefix routing rules.",
};

export default function ProvidersPage() {
  return <ProvidersView />;
}
