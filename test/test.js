var astToFactory_1 = require('../lib/astToFactory');
var fs = require('fs');
var s = require('typescript-schema');
var rawPkg = astToFactory_1.packageAstToFactory('.');
var serializable = rawPkg.construct(s.factoryToSerializable())();
fs.writeFileSync('test/test.json', s.stringifyModules(serializable.modules));
var reflective = rawPkg.construct(s.factoryToReflective())();
function a() { }
exports.a = a;
//# sourceMappingURL=test.js.map