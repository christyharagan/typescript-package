var astToFactory_1 = require('../lib/astToFactory');
var s = require('typescript-schema');
var rawPkg = astToFactory_1.packageAstToFactory('.');
var reflective = rawPkg.construct(s.factoryToReflective())();
console.log(reflective);
function a() { }
exports.a = a;
//# sourceMappingURL=test.js.map