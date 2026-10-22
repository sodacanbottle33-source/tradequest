// Chooses who the owner (admin) of this TradeQuest is. Only the person who runs the server can do this.
//   npm run owner -- <username>     make <username> the owner (restart the server afterwards)
//   npm run owner -- --clear        nobody is the owner any more
//   npm run owner                   show who the owner is
import { OWNER_FILE, clearOwnerFile, dataDirOf, loadConfig, writeOwnerFile } from '../server/config';

function main(): void {
  const dataDir = dataDirOf();
  const arg = process.argv[2];
  if (arg === undefined) {
    const owner = loadConfig().ownerUsername;
    console.log(owner === '' ? 'There is no owner yet.' : `The owner is "${owner}".`);
    console.log('To choose one:  npm run owner -- <username>');
    return;
  }
  if (arg === '--clear') {
    console.log(clearOwnerFile(dataDir) ? `Removed ${OWNER_FILE}. After the next server start nobody is the owner.` : 'There was no owner file.');
    if ((process.env.TQ_OWNER ?? '') !== '') console.log('Note: the TQ_OWNER setting is still in this window and still names an owner.');
    return;
  }
  const file = writeOwnerFile(dataDir, arg);
  console.log(`Saved "${arg}" as the owner in ${file}`);
  console.log('1. Restart the server (stop it with Ctrl+C, then: npm run server).');
  console.log(`2. In the app, log in as "${arg}" (or create that account: profile button → Create account).`);
  console.log('3. Open the profile button again: the menu now has "Admin panel".');
  if ((process.env.TQ_OWNER ?? '') !== '') console.log('Note: TQ_OWNER is set in this window and takes priority over this file.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
