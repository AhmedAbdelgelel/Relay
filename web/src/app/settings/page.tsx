import type { Metadata } from "next";
import { SettingsView } from "@/components/pages/settings/SettingsView";

export const metadata: Metadata = {
  title: "Settings · Relay",
  description:
    "Gateway connection, the Advanced toggle for technical surfaces, the last captured exchange and the live cache configuration.",
};

export default function SettingsPage() {
  return <SettingsView />;
}
