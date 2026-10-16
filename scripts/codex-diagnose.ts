import { RpcClient } from '../packages/adapters/src/codex';
const client = new RpcClient({
  executable: 'codex',
  workspace: process.cwd(),
  approve: async () => false,
});
try {
  await client.connect();
  const config = await client.request('config/read', { includeLayers: false });
  console.log('Configured model:', config.config?.model ?? '(default)');
  console.log(
    'Configured provider:',
    config.config?.model_provider ?? '(default)',
  );
  const account = await client.request('account/read', { refreshToken: false });
  console.log('Account type:', account.account?.type ?? '(none)');
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  client.dispose();
}
