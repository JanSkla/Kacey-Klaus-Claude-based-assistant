/* Closing-phrase classifier.

   The half that matters is MUST_NOT: a list that ends the conversation on an
   ordinary request is worse than having no closing phrase at all, because the
   failure is silent — you keep talking and she is no longer listening.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = process.argv[2] ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'closing.js');

globalThis.window = {};
new Function(fs.readFileSync(SRC, 'utf8'))();
const C = globalThis.window.KaceyClosing;
if (!C) throw new Error('closing.js did not attach KaceyClosing');

const CLOSE = [
  // the phrase that prompted this, and its neighbourhood
  'To je vše, díky.',
  'to je vše',
  'Tak to je vše, díky Kacey.',
  'Děkuji, to je všechno.',
  'To bude vše.',
  'To bude všechno, děkuji.',
  'To je zatím vše.',
  'To je pro dnes vše.',
  // nothing further
  'Už nic.',
  'Už nic dalšího, díky.',
  'Nic víc.',
  'To stačí.',
  'Už stačí',
  // done / farewell
  'Konec.',
  'Hotovo.',
  'Končíme.',
  'Dobrou noc.',
  'Na shledanou.',
  'Nashledanou!',
  'Můžeš jít.',
  'Jsi volná.',
  // a closing tacked onto a real request — should do the job AND finish
  'Zapiš mi schůzku v deset, to je vše.',
  'Poznamenej si to, to je všechno díky.',
  // English
  "That's all, thanks.",
  'Thank you, that\'s all.',
  'That will be all.',
  'Nothing else, thanks.',
  'Good night.',
  'Goodbye.',
  "We're done.",
  'You can go.',
];

const INTERRUPT = [
  // the words that cut her off mid-reply
  'Ticho',
  'Ticho!',
  'Buď ticho.',
  'Ticho prosím.',
  'Mlč.',
  'Mlčte.',
  'Buď potichu.',
  'Přestaň mluvit.',
  'Nemluv.',
  'Quiet.',
  'Be quiet.',
  'Stop talking.',
];

// These used to be a separate 'hush' family that switched the wake word off.
// They are ordinary goodbyes now — the wake word is a setting with a button.
const END_WAS_HUSH = [
  'Přestaň poslouchat.',
  'Přestaň mě poslouchat.',
  'Už neposlouchej.',
  'Vypni mikrofon.',
  'Nech mě být.',
  'Stop listening.',
  'Turn off the mic.',
  'Leave me alone.',
];

const MUST_NOT = [
  // the same words, inside a genuine question
  'To je vše, co potřebuju vědět o té schůzce.',
  'Řekni mi, jestli je to všechno správně.',
  'Ne, to není vše.',
  'Vše je v pořádku?',
  'Co mám dnes vše v kalendáři?',
  'Stačí ti to?',
  'Poznamenej si, že to stačí na dnes koupit dva kusy.',
  // bare courtesy is not a goodbye
  'Díky.',
  'Děkuji.',
  'Děkuji ti moc.',
  'Ok, díky.',
  'No dobře.',
  // "vypni" without the microphone
  'Vypni světla v kuchyni.',
  'Vypni budík na zítra.',
  // "nic" as part of an instruction
  'Nic si nezapisuj.',
  'Nic z toho nemaž.',
  // ordinary requests
  'Kolik toho ještě zbývá?',
  'Přečti mi to znovu.',
  'Můžeš jít do detailu?',
  'Dobrou noc bych chtěl přát Petrovi.',
  'What else is on for tomorrow?',
  'Read that back to me.',
  // nothing at all
  '',
  '   ',
];

let bad = 0;
const report = (label, input, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  const shown = input === '' ? '(empty)' : input.trim() === '' ? '(blank)' : input;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(9)} ${JSON.stringify(shown)}` +
    (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};

console.log('--- must classify as end (stop the hands-free loop) ---');
for (const s of CLOSE) report('end', s, C.classify(s), 'end');
console.log('\n--- must classify as interrupt (be quiet NOW) ---');
for (const s of INTERRUPT) report('interrupt', s, C.classify(s), 'interrupt');
console.log('\n--- former hush phrases are ordinary goodbyes now ---');
for (const s of END_WAS_HUSH) report('end', s, C.classify(s), 'end');
console.log('\n--- must NOT match (false positives break the app quietly) ---');
for (const s of MUST_NOT) report('pass-thru', s, C.classify(s), null);

const n = CLOSE.length + INTERRUPT.length + END_WAS_HUSH.length + MUST_NOT.length;
console.log(`\nphrase table: ${JSON.stringify(C._counts())}`);
console.log(`${n - bad}/${n} passed`);
process.exit(bad ? 1 : 0);
