/** Test-only gh executable. No request leaves the loopback fake GitHub server. */
export {};
const args = process.argv.slice(2);
if (args[0] === 'webhook') {
  console.error('Forwarding Webhook events from GitHub...');
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  const path = args.find((a) => a.startsWith('repos/'))!;
  const method = args[args.indexOf('--method') + 1] ?? 'GET';
  const body = args.includes('--input') ? await new Response(Bun.stdin).text() : undefined;
  const response = await fetch(`${process.env.RELAY_TEST_GITHUB_URL}/${path}`, {
    method, body, headers: { 'x-test-account': process.env.RELAY_TEST_ACCOUNT ?? 'alice' },
  });
  const headers = [...response.headers].map(([key, value]) => `${key}: ${value}`).join('\r\n');
  console.log(`HTTP/2.0 ${response.status} Test\r\n${headers}\r\n\r\n${await response.text()}`);
  process.exit(response.ok ? 0 : 1);
}
