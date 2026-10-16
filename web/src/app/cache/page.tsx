import type { Metadata } from "next";
import { CacheView } from "@/components/pages/cache/CacheView";

export const metadata: Metadata = {
  title: "Cache · Relay",
  description:
    "Exact and semantic cache configuration plus live hit/miss metrics from the gateway.",
};

export default function CachePage() {
  return <CacheView />;
}
