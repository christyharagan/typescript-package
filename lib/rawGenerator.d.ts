import * as s from 'typescript-schema';
import * as ts from 'typescript';
import * as utils from './packageUtils';
export declare function generateRawPackage(pkgDir: string, options?: ts.CompilerOptions, host?: ts.CompilerHost): s.KeyValue<s.RawTypeContainer>;
export declare function generateRawModules(p: ts.Program, rootDir: string, relativePrefix?: string | utils.RelativePrefix): s.KeyValue<s.RawTypeContainer>;
