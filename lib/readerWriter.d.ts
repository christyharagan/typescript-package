import * as s from 'typescript-schema';
import * as ts from 'typescript';
export declare function writePackageSchema(pkgDir: string, options?: ts.CompilerOptions, host?: ts.CompilerHost, schemaPath?: string): s.KeyValue<s.reflective.Module>;
export declare function readPackageSchema(pkgDir: string, schemaPath?: string): s.KeyValue<s.reflective.Module>;
