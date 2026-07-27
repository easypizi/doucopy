export async function runRelay(): Promise<void> {
  const { buildApp } = await import("../../relay/dist/index.js");
  const app = buildApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
}
