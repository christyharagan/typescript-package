var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") return Reflect.decorate(decorators, target, key, desc);
    switch (arguments.length) {
        case 2: return decorators.reduceRight(function(o, d) { return (d && d(o)) || o; }, target);
        case 3: return decorators.reduceRight(function(o, d) { return (d && d(target, key)), void 0; }, void 0);
        case 4: return decorators.reduceRight(function(o, d) { return (d && d(target, key, o)) || o; }, desc);
    }
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var astToFactory_1 = require('../lib/astToFactory');
var fs = require('fs');
var s = require('typescript-schema');
var decorators_1 = require('./decorators');
var rawPkg = astToFactory_1.packageAstToFactory('.');
var serializable = rawPkg.construct(s.factoryToSerializable())();
fs.writeFileSync('test/test.json', s.stringifyModules(serializable.modules));
var reflective = rawPkg.construct(s.factoryToReflective())();
var A = (function () {
    function A() {
    }
    A = __decorate([
        decorators_1.testDecorator(), 
        __metadata('design:paramtypes', [])
    ], A);
    return A;
})();
exports.A = A;
//# sourceMappingURL=test.js.map