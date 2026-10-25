/* `node --test test/` runs this file: Node treats the folder as a module and loads its index.js.
   It loads every *.test.js in this folder, so a new test file is picked up without changing the command.
   One file can still be run on its own, e.g. node --test test/smoke.test.js */
const fs = require('fs');

fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort().forEach(f => require('./' + f));
