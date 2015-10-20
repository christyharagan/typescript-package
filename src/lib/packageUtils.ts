import * as fs from 'fs'
import * as path from 'path'
import * as m from './model'
import * as ts from 'typescript'

export function getProgram(packageDir: string, options?: ts.CompilerOptions, host?: ts.CompilerHost) {
  let files = loadAllFiles(getSourceFilesList(packageDir))
  let tsConfig = getTSConfig(packageDir)
  return ts.createProgram(files, options || {
    target: tsConfig.compilerOptions.target,
    moduleResolution:tsConfig.compilerOptions.moduleResolution
  }, host)
}

export function loadAllFiles(files: string[]): string[] {
  let allFiles: {[fileName:string]:boolean} = {}
  let allFilesArr: string[] = []
  files.forEach(function(fileName) {
    allFilesArr.push(fileName)
  })

  function loadFile(fileName: string) {
    if (!allFiles[fileName]) {
      allFiles[fileName] = true
      allFilesArr.push(fileName)

      let processed = ts.preProcessFile(fs.readFileSync(fileName).toString(), true)

      processed.referencedFiles.concat(processed.importedFiles).forEach(function(referencedFile) {
        let referenceFileName = path.join(path.dirname(fileName), referencedFile.fileName)
        if (referenceFileName.indexOf('.ts') !== referenceFileName.length - 3) {
          if (fs.existsSync(referenceFileName + '.ts')) {
            referenceFileName += '.ts'
          } else {
            referenceFileName += '.d.ts'
          }
        }
        if (fs.existsSync(referenceFileName)) {
          loadFile(referenceFileName)
        }
      })
    }
  }

  files.forEach(loadFile)

  return allFilesArr
}

export function getSourceFilesList(packageDir: string): string[] {
  let tsConfig = getTSConfig(packageDir)
  if (tsConfig.files) {
    return tsConfig.files.map(function(file) {
      return path.join(packageDir, file)
    })
  } else {
    return ts.sys.readDirectory(packageDir, '.ts', tsConfig.exclude)
      .concat(ts.sys.readDirectory(packageDir, '.tsx', tsConfig.exclude))
      .concat(ts.sys.readDirectory(packageDir, '.d.ts', tsConfig.exclude)).map(function(file){
        if (file.substring(0, 2) === './' || file.substring(0, 2) === '.\\') {
          return file.substring(2)
        } else {
          return file
        }
      })
  }
}

export function getPackageJson(packageDir: string): m.PackageJSON {
  return <m.PackageJSON>JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json')).toString())
}

export function getTSConfig(packageDir: string): m.TSConfigJSON {
  let tsConfigPath = path.join(packageDir, 'tsconfig.json')
  let tsConfig = JSON.parse(fs.readFileSync(tsConfigPath).toString())
  tsConfig.compilerOptions.target = (()=>{
    switch ((<string>tsConfig.compilerOptions.target).toLowerCase()) {
      case 'es3':
        return ts.ScriptTarget.ES3
      case 'es5':
        return ts.ScriptTarget.ES5
      case 'es6':
        return ts.ScriptTarget.ES6
      default:
        return ts.ScriptTarget.Latest
    }
  })()
  tsConfig.compilerOptions.moduleResolution = (()=>{
    switch (tsConfig.compilerOptions.moduleResolution ? (<string>tsConfig.compilerOptions.moduleResolution).toLowerCase() : '') {
      case 'node':
        return ts.ModuleResolutionKind.NodeJs
      default:
        return ts.ModuleResolutionKind.Classic
    }
  })()
  return <m.TSConfigJSON>tsConfig
}

export type RelativePrefix = (fileName:string, relativeModuleName:string)=>string

export function fileNameToModuleName(fileName: string, pkgDir?: string, relativePrefix?: string|RelativePrefix): string {
  let moduleName:string
  if (path.isAbsolute(fileName)) {
    moduleName = path.relative(pkgDir, fileName)
  } else {
    moduleName = fileName
  }

  moduleName = moduleName.replace(/\\/g, '/')
  if (moduleName.indexOf('.d.ts') === moduleName.length - 5) {
    moduleName = moduleName.substring(0, moduleName.length - 5)
  } else if (moduleName.indexOf('.ts') === moduleName.length - 3 || moduleName.indexOf('.js') === moduleName.length - 3) {
    moduleName = moduleName.substring(0, moduleName.length - 3)
  }

  if (relativePrefix) {
    if ((<string>relativePrefix).charAt) {
      return path.posix.join(relativePrefix, moduleName)
    } else {
      return (<RelativePrefix>relativePrefix)(fileName, moduleName)
    }
  } else {
    if (moduleName.substring(0, 2) !== './') {
      moduleName = './' + moduleName
    }
    return moduleName
  }
}
