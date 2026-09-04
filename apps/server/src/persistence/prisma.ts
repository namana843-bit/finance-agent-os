// Finance Agent OS — Prisma persistence stub
// Uses DATABASE_URL if set; falls back to no-op so dev without DB still works.
// Run: pnpm prisma generate && pnpm prisma db push
// Schema: prisma/schema.prisma (sqlite default, pg for prod)

let prisma: unknown | null = null;
let attempted = false;

export async function getPrisma(): Promise<unknown | null> {
  if (attempted) return prisma;
  attempted = true;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("[prisma] DATABASE_URL not set — persistence disabled (in-memory only)");
    return null;
  }
  try {
    // @ts-ignore - optional dep, installed via `pnpm add @prisma/client && npx prisma generate` when DB wanted
    const mod = await import("@prisma/client");
    const PrismaClient = (mod as unknown as { PrismaClient: new () => unknown }).PrismaClient;
    prisma = new PrismaClient();
    console.log("[prisma] connected", url.replace(/:[^:@]+@/, ":****@"));
    return prisma;
  } catch (e) {
    console.warn("[prisma] @prisma/client not available — run pnpm add @prisma/client && npx prisma generate; persistence disabled", (e as Error).message);
    return null;
  }
}

export function isPersistenceEnabled(): boolean {
  return !!process.env.DATABASE_URL;
}
