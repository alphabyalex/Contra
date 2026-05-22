import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
import { listScoredMarkets } from './db/queries';
const ids = ['0xd07ad157463306284e16a0f897510948a1ff9904c4cbf0992e1421e62a079d38','0xc8a898fa8ce2121e3bba1ee52120ed8ab4f8ea7ed5a6dcd9b138fe7b9e454c0b','0x8c3455f1a9afbd5a7911fbf1c0d454359ad99f0f518d84641857ca754e7c4dd5','0x663ab202c03a5e1d399578d44a3b124307db73caba79b2ead36c52ce6094b2d4','0x1b1a75d6305f5edee255b3f368cca945bde401fea4b2a7e34f2fcca3b3e56cf0'];
(async () => {
  const all = await listScoredMarkets();
  for (const id of ids) { const m = all.find((x) => x.condition_id === id); console.log(id.slice(0, 10), '→', m ? m.question.slice(0, 60) : '(not in scored)'); }
  process.exit(0);
})();
