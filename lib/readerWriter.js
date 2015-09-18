var path = require('path');
var fs = require('fs');
var s = require('typescript-schema');
var utils = require('./packageUtils');
var g = require('./rawGenerator');
function writePackageSchema(pkgDir, options, host, schemaPath) {
    schemaPath = path.join(pkgDir, schemaPath || 'packageSchema.json');
    var pkgName = utils.getPackageJson(pkgDir).name;
    var rawPackage = g.generateRawPackage(pkgDir, options, host);
    var rawSchema = s.filterRawModules(function (moduleName) { return moduleName.indexOf(pkgName) === 0; }, rawPackage);
    fs.writeFileSync(schemaPath, s.stringifyModules(rawSchema));
    return s.convertRawModules(rawSchema);
}
exports.writePackageSchema = writePackageSchema;
function readPackageSchema(pkgDir, schemaPath) {
    schemaPath = path.join(pkgDir, schemaPath || 'packageSchema.json');
    return s.convertRawModules(s.parseModules(fs.readFileSync(schemaPath).toString()));
}
exports.readPackageSchema = readPackageSchema;
//# sourceMappingURL=readerWriter.js.map