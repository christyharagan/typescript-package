var fs = require('fs');
var path = require('path');
var ts = require('typescript');
function getProgram(packageDir, options, host) {
    var files = loadAllFiles(getSourceFilesList(packageDir));
    var tsConfig = getTSConfig(packageDir);
    return ts.createProgram(files, options || {
        target: tsConfig.compilerOptions.target,
        moduleResolution: tsConfig.compilerOptions.moduleResolution
    }, host);
}
exports.getProgram = getProgram;
function loadAllFiles(files) {
    var allFiles = {};
    var allFilesArr = [];
    files.forEach(function (fileName) {
        allFilesArr.push(fileName);
    });
    function loadFile(fileName) {
        if (!allFiles[fileName]) {
            allFiles[fileName] = true;
            allFilesArr.push(fileName);
            var processed = ts.preProcessFile(fs.readFileSync(fileName).toString(), true);
            processed.referencedFiles.concat(processed.importedFiles).forEach(function (referencedFile) {
                var referenceFileName = path.join(path.dirname(fileName), referencedFile.fileName);
                if (referenceFileName.indexOf('.ts') !== referenceFileName.length - 3) {
                    if (fs.existsSync(referenceFileName + '.ts')) {
                        referenceFileName += '.ts';
                    }
                    else {
                        referenceFileName += '.d.ts';
                    }
                }
                if (fs.existsSync(referenceFileName)) {
                    loadFile(referenceFileName);
                }
            });
        }
    }
    files.forEach(loadFile);
    return allFilesArr;
}
exports.loadAllFiles = loadAllFiles;
function getSourceFilesList(packageDir) {
    var tsConfig = getTSConfig(packageDir);
    if (tsConfig.files) {
        return tsConfig.files.map(function (file) {
            return path.join(packageDir, file);
        });
    }
    else {
        return ts.sys.readDirectory(packageDir, '.ts', tsConfig.exclude)
            .concat(ts.sys.readDirectory(packageDir, '.tsx', tsConfig.exclude))
            .concat(ts.sys.readDirectory(packageDir, '.d.ts', tsConfig.exclude)).map(function (file) {
            if (file.substring(0, 2) === './' || file.substring(0, 2) === '.\\') {
                return file.substring(2);
            }
            else {
                return file;
            }
        });
    }
}
exports.getSourceFilesList = getSourceFilesList;
function getPackageJson(packageDir) {
    return JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json')).toString());
}
exports.getPackageJson = getPackageJson;
function getTSConfig(packageDir) {
    var tsConfigPath = path.join(packageDir, 'tsconfig.json');
    var tsConfig = JSON.parse(fs.readFileSync(tsConfigPath).toString());
    tsConfig.compilerOptions.target = (function () {
        switch (tsConfig.compilerOptions.target.toLowerCase()) {
            case 'es3':
                return 0;
            case 'es5':
                return 1;
            case 'es6':
                return 2;
            default:
                return 2;
        }
    })();
    tsConfig.compilerOptions.moduleResolution = (function () {
        switch (tsConfig.compilerOptions.moduleResolution ? tsConfig.compilerOptions.moduleResolution.toLowerCase() : '') {
            case 'node':
                return 2;
            default:
                return 1;
        }
    })();
    return tsConfig;
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