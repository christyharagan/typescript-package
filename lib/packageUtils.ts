import * as fs from 'fs'
import * as path from 'path'
import * as m from './model'
import * as ts from 'typescript'

export function getProgram(packageDir: string, options?: ts.CompilerOptions, host?: ts.CompilerHost) {
  return ts.createProgram(getSourceFilesList(packageDir), options || { target: ts.ScriptTarget.ES5 }, host)
}

export function getSourceFilesList(packageDir: string): string[] {
  return getTSConfig(packageDir).files.map(function(file) {
    return path.join(packageDir, file)
  })
}

export function getPackageJson(packageDir: string): m.PackageJSON {
  return <m.PackageJSON>JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json')).toString())
}

export function getTSConfig(packageDir: string): m.TSConfigJSON {
  return <m.TSConfigJSON>JSON.parse(fs.readFileSync(path.join(packageDir, 'tsconfig.json')).toString())
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
