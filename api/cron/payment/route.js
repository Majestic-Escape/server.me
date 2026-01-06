export async function GET() {
  console.log("Cron job executed");

  return new Response(
    JSON.stringify({ success: true, message: "Cron ran successfully" }),
    { status: 200 }
  );
}
