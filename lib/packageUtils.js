var fs = require('fs');
var path = require('path');
var ts = require('typescript');
function getProgram(packageDir, options, host) {
    return ts.createProgram(getSourceFilesList(packageDir), options || { target: 1 }, host);
}
exports.getProgram = getProgram;
function getSourceFilesList(packageDir) {
    return getTSConfig(packageDir).files.map(function (file) {
        return path.join(packageDir, file);
    });
}
exports.getSourceFilesList = getSourceFilesList;
function getPackageJson(packageDir) {
    return JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json')).toString());
}
exports.getPackageJson = getPackageJson;
function getTSConfig(packageDir) {
    return JSON.parse(fs.readFileSync(path.join(packageDir, 'tsconfig.json')).toString());
}
exports.getTSConfig = getTSConfig;
function fileNameToModuleName(fileName, pkgDir, relativePrefix) {
    var moduleName;
    if (path.isAbsolute(fileName)) {
        moduleName = path.relative(pkgDir, fileName);
    }
    else {
        moduleName = fileName;
    }
    moduleName = moduleName.replace(/\\/g, '/');
    if (moduleName.indexOf('.d.ts') === moduleName.length - 5) {
        moduleName = moduleName.substring(0, moduleName.length - 5);
    }
    else if (moduleName.indexOf('.ts') === moduleName.length - 3 || moduleName.indexOf('.js') === moduleName.length - 3) {
        moduleName = moduleName.substring(0, moduleName.length - 3);
    }
    if (relativePrefix) {
        if (relativePrefix.charAt) {
            return path.posix.join(relativePrefix, moduleName);
        }
        else {
            return relativePrefix(fileName, moduleName);
        }
    }
    else {
        if (moduleName.substring(0, 2) !== './') {
            moduleName = './' + moduleName;
        }
        return moduleName;
    }
}
exports.fileNameToModuleName = fileNameToModuleName;
//# sourceMappingURL=packageUtils.js.map