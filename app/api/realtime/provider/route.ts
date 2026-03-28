import { NextResponse } from "next/server";
import {
  getAvailableRealtimeProviders,
  getRealtimeProviderErrorMessage,
  resolveConfiguredRealtimeProvider,
} from "@/lib/realtime-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const provider = resolveConfiguredRealtimeProvider();
  if (!provider) {
    return NextResponse.json(
      { error: getRealtimeProviderErrorMessage() },
      { status: 500 },
    );
  }

  return NextResponse.json({
    provider,
    availableProviders: getAvailableRealtimeProviders(),
  });
}
