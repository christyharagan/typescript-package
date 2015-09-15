var rawGenerator_1 = require('../lib/rawGenerator');
var fs = require('fs');
var s = require('typescript-schema');
var rawPkg = rawGenerator_1.generateRawPackage('.');
s.convertRawModules(rawPkg);
fs.writeFileSync('test/test.json', s.stringifyModules(rawPkg));
function a() { }
exports.a = a;
//# sourceMappingURL=test.js.map