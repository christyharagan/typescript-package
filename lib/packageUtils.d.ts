import * as m from './model';
import * as ts from 'typescript';
export declare function getProgram(packageDir: string, options?: ts.CompilerOptions, host?: ts.CompilerHost): ts.Program;
export declare function getSourceFilesList(packageDir: string): string[];
export declare function getPackageJson(packageDir: string): m.PackageJSON;
export declare function getTSConfig(packageDir: string): m.TSConfigJSON;
export declare type RelativePrefix = (fileName: string, relativeModuleName: string) => string;
export declare function fileNameToModuleName(fileName: string, pkgDir?: string, relativePrefix?: string | RelativePrefix): string;
