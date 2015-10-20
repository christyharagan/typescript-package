import * as m from './model'
import * as s from 'typescript-schema'
import * as ts from 'typescript'
import * as path from 'path'
import * as fs from 'fs'
import * as utils from './packageUtils'

export function packageAstToFactory(pkgDir: string, options?: ts.CompilerOptions, host?: ts.CompilerHost): s.PackageFactory {
  let allRawModules: s.KeyValue<s.ModuleFactory> = {}
  let files = utils.getSourceFilesList(pkgDir)
  let pkgs: s.KeyValue<[string, string]> = {}
  let p = utils.getProgram(pkgDir, options, host)

  while (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
    if (pkgDir === path.join(pkgDir, '..')) {
      throw new Error('Package not found')
    }
    pkgDir = path.dirname(pkgDir)
  }

  p.getSourceFiles().forEach(function(sf) {
    let file = sf.fileName
    let dirName = path.dirname(file)
    while (true) {
      if (fs.existsSync(path.join(dirName, 'tsconfig.json')) || fs.existsSync(path.join(dirName, 'package.json'))) {
        let rootDir = '.'
        if (fs.existsSync(path.join(dirName, 'tsconfig.json'))) {
          rootDir = utils.getTSConfig(dirName).compilerOptions.rootDir || rootDir
          if (file.indexOf(path.join(dirName, rootDir)) !== 0) {
            rootDir = '.'
          }
        }
        rootDir = path.join(dirName, rootDir)
        while (!fs.existsSync(path.join(dirName, 'package.json'))) {
          if (dirName === path.join(dirName, '..')) {
            throw new Error('Package not found for file: ' + file)
          }
          dirName = path.dirname(dirName)
        }
        let pkgJson = <m.PackageJSON>JSON.parse(fs.readFileSync(path.join(dirName, 'package.json')).toString())
        pkgs[file] = [pkgJson.name, path.relative(pkgDir, rootDir).replace(/\\/g, '/')]
        break
      } else {
        dirName = path.dirname(dirName)
      }
      if (dirName === path.join(dirName, '..')) {
        throw new Error('Package not found for file: ' + file)
      }
    }
  })

  function relativePrefix(fileName: string, moduleName: string) {
    let pkg = pkgs[fileName]
    return path.posix.join(pkg[0], path.posix.relative(pkg[1], moduleName))
  }

  let packageFactory = new s.PackageFactory()
  packageFactory.modules = moduleAstsToFactory(p, pkgDir, relativePrefix)

  return packageFactory
}

export function moduleAstsToFactory(p: ts.Program, rootDir: string, relativePrefix?: string | utils.RelativePrefix): s.KeyValue<s.ModuleFactory> {
  let moduleFactories: s.KeyValue<s.ModuleFactory> = {}
  let globals = getGlobals(p)
  let tc = p.getTypeChecker()
  let namespacesAsModules: s.KeyValue<[ts.Symbol, ts.SourceFile][]> = {}

  p.getSourceFiles().forEach(sf => {
    processSourceFile(sf)
  })

  function processSourceFile(sf: ts.SourceFile): string[] {
    let moduleNames: string[] = []
    let isModule = false
    ts.forEachChild(sf, function(node) {
      if (node.kind === ts.SyntaxKind.ExportAssignment) {
        isModule = true

        let exportAssignment = <ts.ExportAssignment>node
        let exportSymbol = tc.getSymbolAtLocation(exportAssignment.expression)
        if (exportSymbol && exportSymbol.declarations && exportSymbol.declarations[0].kind === ts.SyntaxKind.ModuleDeclaration) {
          let modDec = <ts.ModuleDeclaration>exportSymbol.declarations[0]
          let forName = namespacesAsModules[modDec.name.text]
          if (!forName) {
            forName = []
            namespacesAsModules[modDec.name.text] = forName
          }
          forName.push([exportSymbol, sf])
        }
      } else if (isExported(node) || node.kind === ts.SyntaxKind.ExportDeclaration) {
        isModule = true
      }
    })
    if (isModule) {
      let moduleName = utils.fileNameToModuleName(sf.fileName, rootDir, relativePrefix)
      processModule(moduleName, sf, moduleFactories[moduleName])
      moduleNames.push(moduleName)
    } else {
      moduleNames = moduleNames.concat(processDeclarationFile(sf))
    }

    return moduleNames
  }

  function processModule(moduleName: string, moduleNode: ts.Node, module?: s.ModuleFactory, isDeclared?: boolean) {
    module = module || moduleFactories[moduleName]
    if (!module) {
      module = new s.ModuleFactory(moduleName)
      moduleFactories[moduleName] = module
    }

    processContainer(module, moduleNode, isDeclared)

    return module
  }

  function processDeclarationFile(declarationFile: ts.SourceFile): string[] {
    let globalModule = moduleFactories['']
    if (!globalModule) {
      globalModule = new s.ModuleFactory('')
      moduleFactories[''] = globalModule
    }
    return processContainer(globalModule, declarationFile, true)
  }

  function processExport(container: s.AbstractContainerFactory, node: ts.Node) {
    switch (node.kind) {
      case ts.SyntaxKind.VariableStatement:
      case ts.SyntaxKind.FunctionDeclaration:
        populateValue(node, container)
        break
      case ts.SyntaxKind.InterfaceDeclaration:
        populateInterface(<ts.InterfaceDeclaration>node, container, {})
        break
      case ts.SyntaxKind.ClassDeclaration:
        populateClass(<ts.ClassDeclaration>node, container, {})
        break
      case ts.SyntaxKind.EnumDeclaration:
        populateEnum(<ts.EnumDeclaration>node, container)
        break
      case ts.SyntaxKind.TypeAliasDeclaration:
        populateTypeAliasConstructor(<ts.TypeAliasDeclaration>node, container, {})
        break
    }
  }

  function addReference(ref:s.ContainedFactory<any>, name: string, typeContainer: s.AbstractContainerFactory) {
    switch (ref.modelKind) {
      case s.ModelKind.CLASS_CONSTRUCTOR:
        typeContainer.classConstructors[name] = <s.ClassConstructorFactory>ref
        return
      case s.ModelKind.INTERFACE_CONSTRUCTOR:
        typeContainer.interfaceConstructors[name] = <s.InterfaceConstructorFactory>ref
        return
      case s.ModelKind.TYPE_ALIAS_CONSTRUCTOR:
        typeContainer.typeAliasConstructors[name] = <s.TypeAliasConstructorFactory<any>>ref
        return
      case s.ModelKind.VALUE:
        typeContainer.values[name] = <s.ValueFactory<any>>ref
        return
      case s.ModelKind.TYPE:
        typeContainer.enums[name] = <s.EnumFactory>ref
        return
    }
  }

  function processSymbolTable(typeContainer: s.AbstractContainerFactory, symbolTable: ts.SymbolTable) {
    Object.keys(symbolTable).forEach(function(name) {
      let symbol = symbolTable[name]
      // It can be, when the export is a class that the prototype export is in the symbol table, but it has no declarations.
      // Need a proper fix to this scenario
      if (symbol && symbol.declarations) {
        symbol.declarations.forEach(function(dec) {
          if (dec.kind === ts.SyntaxKind.ExportDeclaration) {
            let exportDec = <ts.ExportDeclaration>dec
            processSymbolTable(typeContainer, tc.getSymbolAtLocation(exportDec.moduleSpecifier).exports)
          } else if (dec.kind === ts.SyntaxKind.ExportAssignment) {
            // TODO: There seems to be a change between v1.5 and v1.6/v1.7. This is duplicated code with processTypeContainer
            // Copying here so all versions work, but this requires a proper investigation

            // TODO: This is not a complete solution
            let exportAssignment = <ts.ExportAssignment>dec
            let exportSymbol = tc.getSymbolAtLocation(exportAssignment.expression)
            let exportType = tc.getTypeAtLocation(exportAssignment.expression)

            if (exportType && exportType.symbol && exportType.symbol.exports) {
              // TODO: There is a funky thing when the export is a class and a module (a la the Twitter typings)
              // E.g; declare class Twitter{} declare module Twitter{}
              processSymbolTable(typeContainer, exportType.symbol.exports || exportType.symbol.members)
            } else if (exportSymbol.exports) {
              processSymbolTable(typeContainer, exportSymbol.exports)
            } else {
              let importDec = <ts.ImportEqualsDeclaration>exportSymbol.declarations[0]
              processSymbolTable(typeContainer, tc.getTypeAtLocation(importDec).symbol.exports || tc.getTypeAtLocation(importDec).symbol.members)
            }
          } else {
            // TODO: How do we handle call signatures as exports?
            if (dec.kind !== ts.SyntaxKind.CallSignature) {
              let ref = <s.ContainedFactory<any>>getReference(dec, dec.kind === ts.SyntaxKind.ModuleDeclaration)
              if (ref.parent === typeContainer) {
                switch (ref.modelKind) {
                  case s.ModelKind.CLASS_CONSTRUCTOR:
                    populateClass(<ts.ClassDeclaration>dec, typeContainer, {})
                    break
                  case s.ModelKind.INTERFACE_CONSTRUCTOR:
                    populateInterface(<ts.InterfaceDeclaration>dec, typeContainer, {})
                    break
                  case s.ModelKind.TYPE_ALIAS_CONSTRUCTOR:
                    populateTypeAliasConstructor(<ts.TypeAliasDeclaration>dec, typeContainer, {})
                    break
                  case s.ModelKind.TYPE:
                    populateEnum(<ts.EnumDeclaration>dec, typeContainer)
                    break
                  case s.ModelKind.VALUE:
                    populateValue(dec, typeContainer)
                    break
                  case s.ModelKind.CONTAINER:
                    processContainer(<s.NamespaceFactory>ref, dec, true)
                    break
                  default:
                }
              } else {
                addReference(ref, name, typeContainer)
              }
            }
          }
        })
      }
    })
  }

  function processContainer(container: s.AbstractContainerFactory, node: ts.Node, isDeclaredModule: boolean): string[] {
    let moduleNames: string[] = []
    ts.forEachChild(node, function(child: ts.Node) {
      switch (child.kind) {
        case ts.SyntaxKind.ExportAssignment:
          // TODO: This is not a complete solution
          let exportAssignment = <ts.ExportAssignment>child
          let exportSymbol = tc.getSymbolAtLocation(exportAssignment.expression)
          let exportType = tc.getTypeAtLocation(exportAssignment.expression)
          if (exportType && exportType.symbol && exportType.symbol.exports) {
            // TODO: There is a funky thing when the export is a class and a module (a la the Twitter typings)
            // E.g; declare class Twitter{} declare module Twitter{}
            processSymbolTable(container, exportType.symbol.exports || exportType.symbol.members)
          } else if (exportSymbol.exports) {
            processSymbolTable(container, exportSymbol.exports)
          } else {
            let importDec = <ts.ImportEqualsDeclaration>exportSymbol.declarations[0]
            processSymbolTable(container, tc.getTypeAtLocation(importDec).symbol.exports || tc.getTypeAtLocation(importDec).symbol.members)
          }
          break
        case ts.SyntaxKind.ExportDeclaration:
          let exportDec = <ts.ExportDeclaration>child
          let exportClause = exportDec.exportClause
          if (exportClause) {
            exportDec.exportClause.elements.forEach(function(element) {
              addReference(<s.ContainedFactory<any>>getReference(tc.getSymbolAtLocation(element), false), element.name.text, container)
            })
          }
          processSymbolTable(container, tc.getSymbolAtLocation(exportDec.moduleSpecifier).exports || tc.getSymbolAtLocation(exportDec.moduleSpecifier).members)
          break
        default:
          if (isDeclaredModule || moduleFactories[''] === container || isExported(child)) {
            switch (child.kind) {
              case ts.SyntaxKind.ModuleDeclaration:
                let modDec = <ts.ModuleDeclaration>child
                let name = (<ts.StringLiteral>modDec.name).text
                let symbol = tc.getTypeAtLocation(modDec).symbol
                if (moduleFactories[''] === container && symbol && (symbol.name.charAt(0) === '"' || symbol.name.charAt(0) === '\'')) {
                  ts.forEachChild(modDec, function(child) {
                    if (child.kind === ts.SyntaxKind.ModuleBlock) {
                      processModule(name, child, moduleFactories[name], true)
                      moduleNames.push(name)
                    }
                  })
                } else {
                  let namespace = container.addNamespace(name)
                  ts.forEachChild(modDec, function(child) {
                    if (child.kind === ts.SyntaxKind.ModuleBlock) {
                      processContainer(namespace, child, isDeclaredModule || (modDec.modifiers && modDec.modifiers.filter(mod=>mod.kind === ts.SyntaxKind.DeclareKeyword).length > 0))
                    }
                  })
                }
                break
              default:
                processExport(container, child)
            }
          }
      }
    })
    return moduleNames
  }

  function getReference(symbolOrDec: ts.Symbol | ts.Declaration, isModule: boolean): s.Factory<any> {
    let containerFactory: s.ContainerFactory

    let isGlobal: boolean = false
    let dec: ts.Declaration
    let name: string
    if ((<ts.Declaration>symbolOrDec).kind) {
      dec = <ts.Declaration>symbolOrDec
      name = <string>getName(dec.name)
      let globalSymbol = globals.types[name]
      isGlobal = !isModule && globalSymbol && globalSymbol.declarations[0] === dec
    } else {
      let symbol = <ts.Symbol>symbolOrDec

      let i = 0
      dec = symbol.declarations[0]
      while ((dec.kind === ts.SyntaxKind.VariableDeclaration || dec.kind === ts.SyntaxKind.FunctionDeclaration) && (i + 1) < symbol.declarations.length) {
        i++
        dec = symbol.declarations[i]
      }
      name = symbol.name

      isGlobal = !isModule && globals.types[name] === symbol
    }

    if (isGlobal) {
      containerFactory = moduleFactories['']
      if (!containerFactory) {
        containerFactory = new s.ModuleFactory('')
        moduleFactories[''] = <s.ModuleFactory>containerFactory
      }
    } else {
      let moduleName
      let names = []
      let previousName:string

      let node: ts.Node = isModule ? dec : dec.parent
      while (node.kind !== ts.SyntaxKind.SourceFile) {
        switch (node.kind) {
          case ts.SyntaxKind.ModuleDeclaration:
            let mod = <ts.ModuleDeclaration>node
            let forName = namespacesAsModules[mod.name.text]
            if (forName) {
              let shouldBreak = false
              let modSymbol = tc.getTypeAtLocation(mod).symbol
              for (let i = 0; i < forName.length; i++) {
                if (forName[i][0] === modSymbol) {
                  moduleName = utils.fileNameToModuleName(forName[i][1].fileName, rootDir, relativePrefix)
                  shouldBreak = true
                  break
                }
              }
              if (shouldBreak) {
                break
              }
            }
            if (node.parent.kind === ts.SyntaxKind.SourceFile && globals.modules[mod.name.text]) {
              moduleName = mod.name.text
              break
            } else {
              previousName = mod.name.text
              names.splice(0, 0, mod.name.text)
            }
        }
        node = node.parent
      }
      if (moduleName) {
        if (relativePrefix && moduleName.substring(0, 2) === './') {
          if ((<string>relativePrefix).charAt) {
            moduleName = path.posix.join(relativePrefix, moduleName)
          } else {
            moduleName = (<utils.RelativePrefix>relativePrefix)((<ts.SourceFile>node).fileName, moduleName)
          }
        }
      } else if (globals.namespaces[previousName] || (<ts.SourceFile>node).fileName.substring((<ts.SourceFile>node).fileName.length - 8) === 'lib.d.ts') {
        moduleName = ''
      } else {
        moduleName = utils.fileNameToModuleName((<ts.SourceFile>node).fileName, rootDir, relativePrefix)// + (name === '' ? '' : (':' + name))
      }

      containerFactory = moduleFactories[moduleName]
      if (!containerFactory) {
        containerFactory = new s.ModuleFactory(moduleName)
        moduleFactories[moduleName] = <s.ModuleFactory>containerFactory
      }

      names.forEach(function(name){
        containerFactory = containerFactory.addNamespace(name)
      })
    }

    if (isModule) {
      return containerFactory
    } else {
      switch (dec.kind) {
        case ts.SyntaxKind.InterfaceDeclaration:
          return containerFactory.addInterfaceConstructor(name)
        case ts.SyntaxKind.ClassDeclaration:
          return containerFactory.addClassConstructor(name)
        case ts.SyntaxKind.EnumDeclaration:
          return containerFactory.addEnum(name)
        case ts.SyntaxKind.TypeAliasDeclaration:
          return containerFactory.addTypeAliasConstructor(name)
        case ts.SyntaxKind.FunctionDeclaration:
          return containerFactory.addValue(name)
        case ts.SyntaxKind.VariableDeclaration:
          let varDec = <ts.VariableDeclaration>dec
          return containerFactory.addValue(name)
        case ts.SyntaxKind.ModuleDeclaration:
          return containerFactory
        default:
          throw new Error('Unrecognised declaration kind: ' + dec.kind + ' with text: ' + dec.getText())
      }
    }
  }

  function processNode(node: ts.Node, typeParameters: s.KeyValue<s.TypeParameterFactory<any>>): s.Factory<any> {
    let isTypeQuery = node.kind === ts.SyntaxKind.TypeQuery
    if (isTypeQuery) {
      let typeQuery = <ts.TypeQueryNode>node
      let typeSymbol = tc.getSymbolAtLocation(typeQuery.exprName)
      let typeQueryFactory = new s.TypeQueryFactory()
      if (!typeSymbol || !typeSymbol.declarations) {
        return typeQueryFactory
      } else {
        let ref:s.Factory<any>
        let typeSymbolDec = typeSymbol.declarations[0]
        switch (typeSymbolDec.kind) {
          case ts.SyntaxKind.ModuleDeclaration:
            ref = getReference(typeSymbol, true)
          case ts.SyntaxKind.VariableDeclaration:
          case ts.SyntaxKind.FunctionDeclaration:
            ref = getReference(typeSymbol, false)
          default:
            let type = tc.getTypeAtLocation(node)
            if (!type.symbol) {
              ref = getReference(typeSymbol, false)
            } else {
              let declaration = type.symbol.declarations[0]
              if (declaration && declaration.kind === ts.SyntaxKind.ModuleDeclaration) {
                ref = getReference(type.symbol, true)
              } else {
                ref = processType(type, typeParameters)
              }
            }
        }
        typeQueryFactory.type = <s.TypeFactory<any>|s.ValueFactory<any>|s.ContainerFactory>ref
        return typeQueryFactory
      }
    } else {
      let type = tc.getTypeAtLocation(node)
      if ((<ts.GenericType>type).typeParameters) {
        let typeArgNode = (node).kind === ts.SyntaxKind.Identifier ? (node).parent : (node)
        if (typeArgNode.kind === ts.SyntaxKind.ArrayType) {
          let arrayType = <ts.ArrayTypeNode>typeArgNode
          let arrayConstructorFactory = moduleFactories[''].addInterfaceConstructor('Array')
          let arrayFactory = new s.InterfaceFactory()
          arrayFactory.typeConstructor = arrayConstructorFactory
          arrayFactory.typeArguments.push(<s.TypeFactory<any>>processNode(arrayType.elementType, typeParameters))
          return arrayFactory
        } else {
          let typeArguments = (<ts.TypeReferenceNode | ts.ExpressionWithTypeArguments>typeArgNode).typeArguments
          let reference:s.Factory<any>
          if (!type.symbol && tc.getSymbolAtLocation(node)) {
            reference = getReference(tc.getSymbolAtLocation(node), false)
          } else {
            reference = processType(type, typeParameters)
            if (reference.modelKind === s.ModelKind.TYPE) {
              reference = (<s.AbstractConstructableTypeFactory<any, any>>reference).typeConstructor
            }
          }
          let refinedReference:s.AbstractConstructableTypeFactory<any, any>
          switch (reference.modelKind) {
            case s.ModelKind.CLASS_CONSTRUCTOR:
              refinedReference = new s.ClassFactory()
              break
            case s.ModelKind.INTERFACE_CONSTRUCTOR:
              refinedReference = new s.InterfaceFactory()
              break
            case s.ModelKind.TYPE_ALIAS_CONSTRUCTOR:
              refinedReference = new s.TypeAliasFactory<any>()
              break
            default:
              throw new Error('Unexpected expression with type arguments: ' + typeArgNode.getText())
          }
          refinedReference.typeConstructor = reference
          refinedReference.typeArguments = typeArguments.map(function(typeArg) {
            return <s.TypeFactory<any>>processNode(typeArg, typeParameters)
          })
          return refinedReference
        }
      } else if (!type.symbol && tc.getSymbolAtLocation(node)) {
        let sym = tc.getSymbolAtLocation(node)
        let dec = sym.declarations[0]
        if (dec.kind === ts.SyntaxKind.PropertyAssignment) {
          let pa = <ts.PropertyAssignment>dec
          return processNode((<ts.PropertyAssignment>sym.declarations[0]).initializer, typeParameters)

          // TODO: DO NOT DELETE: This will form part of a more complete solution around expressions
          // while (pa) {
          //   let grandParent = pa.parent.parent
          //   if (grandParent.kind === ts.SyntaxKind.PropertyAssignment) {
          //     pa = <ts.PropertyAssignment>grandParent
          //     name = getName(pa.name) + '.' + name
          //   } else {
          //     if (grandParent.kind === ts.SyntaxKind.VariableDeclaration) {
          //       let va = <ts.VariableDeclaration>grandParent
          //       name = getName(va.name) + '.' + name
          //     }
          //     pa = null
          //   }
          // }
        } else {
        // if (sym.declarations[0].kind === ts.SyntaxKind.PropertySignature) {
        //   return processNode((<ts.PropertyAssignment>sym.declarations[0]).initializer, typeParameters)
        // } else {
          return closeReference(<s.TypeConstructorFactory<any>>getReference(tc.getSymbolAtLocation(node), false))
        }
      } else {
        return processType(type, typeParameters)
      }
    }
  }

  function processType(type: ts.Type, typeParameters: s.KeyValue<s.TypeParameterFactory<any>>): s.TypeFactory<any> {
    let reference:s.Factory<any>
    switch (type.flags) {
      case ts.TypeFlags.Any:
        return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.ANY)
      case ts.TypeFlags.String:
      case ts.TypeFlags.StringLiteral:
        return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.STRING)
      case ts.TypeFlags.Number:
        return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.NUMBER)
      case ts.TypeFlags.Boolean:
        return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.BOOLEAN)
      case ts.TypeFlags.Void:
        return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.VOID)
      case ts.TypeFlags.ESSymbol:
        return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.SYMBOL)
      case ts.TypeFlags.Enum:
        return <s.EnumFactory>getReference(type.symbol, false)
      case ts.TypeFlags.Class:
      case ts.TypeFlags.Interface:
      case ts.TypeFlags.Reference + ts.TypeFlags.Class:
      case ts.TypeFlags.Reference + ts.TypeFlags.Interface:
        reference = getReference(type.symbol, false)
        break
      case ts.TypeFlags.TypeParameter:
        if (!typeParameters[type.symbol.name]) {
          throw new Error('Type parameter not found: ' + type.symbol.name)
        } else {
          return typeParameters[type.symbol.name]
        }
      case ts.TypeFlags.Tuple:
        let tupleType = <ts.TupleType>type
        let tupleTypeFactory = new s.TupleTypeFactory()
        tupleTypeFactory.elements = tupleType.elementTypes.map(function(elementType){
          return processType(elementType, typeParameters)
        })
        return tupleTypeFactory
      case ts.TypeFlags.Union:
        let unionType = <ts.UnionType>type
        let unionTypeFactory = new s.UnionOrIntersectionTypeFactory(s.TypeKind.UNION)
        unionTypeFactory.types = unionType.types.map(function(type){
          return processType(type, typeParameters)
        })
        return unionTypeFactory
      case ts.TypeFlags.Intersection:
        let intersectionType = <ts.IntersectionType>type
        let intersectionTypeFactory = new s.UnionOrIntersectionTypeFactory(s.TypeKind.INTERSECTION)
        intersectionTypeFactory.types = intersectionType.types.map(function(type){
          return processType(type, typeParameters)
        })
        return intersectionTypeFactory
      case ts.TypeFlags.Reference:
      case (ts.TypeFlags.Reference + ts.TypeFlags.Interface):
        let referenceType = <ts.TypeReference>type
        reference = getReference(referenceType.target.symbol, false)
        break
      case ts.TypeFlags.Anonymous:
      case ts.TypeFlags.Anonymous + ts.TypeFlags.Instantiated:
        let declaration = type.symbol.declarations[0]
        switch (declaration.kind) {
          case ts.SyntaxKind.FunctionDeclaration:
            return <s.TypeFactory<any>>getReference(<ts.FunctionLikeDeclaration>declaration, false)
          case ts.SyntaxKind.FunctionExpression:
          case ts.SyntaxKind.FunctionType:
          case ts.SyntaxKind.MethodSignature:
          case ts.SyntaxKind.ConstructorType:
            return processSignatureType(<ts.FunctionLikeDeclaration>declaration, false, typeParameters)
          case ts.SyntaxKind.MethodDeclaration:
            return processSignatureType(<ts.FunctionLikeDeclaration>declaration, true, typeParameters)
          case ts.SyntaxKind.ClassDeclaration:
          case ts.SyntaxKind.Constructor:
            reference = getReference(type.symbol, false)
            break
          case ts.SyntaxKind.ObjectLiteralExpression:
            let literalCompositeType = new s.CompositeTypeFactory(null, false)
            let ole = <ts.ObjectLiteralExpression>declaration
            ole.properties.forEach(function(property: ts.ObjectLiteralElement) {
              let member = literalCompositeType.addMember(<string>getName(property.name))
              member.type = <s.TypeFactory<any>>processNode(property, typeParameters)
            })
            return literalCompositeType
          case ts.SyntaxKind.TypeLiteral:
            let typeLiteral = <ts.TypeLiteralNode>declaration
            let compositeType = new s.CompositeTypeFactory(null, false)
            populateMembers(compositeType, typeLiteral.members, false, typeParameters)
            return compositeType
          default:
            throw new Error('Unrecognised Type: ' + type.flags + ' with declaration type: ' + declaration.kind)
        }
        break
      default:
        throw new Error('Unrecognised Type: ' + type.flags)
    }
    return closeReference(<s.TypeConstructorFactory<any>>reference)
  }

  function closeReference(reference:s.TypeConstructorFactory<any>) {
    let refinedReference:s.AbstractConstructableTypeFactory<any, any>
    switch (reference.modelKind) {
      case s.ModelKind.CLASS_CONSTRUCTOR:
        refinedReference = new s.ClassFactory()
        break
      case s.ModelKind.INTERFACE_CONSTRUCTOR:
        refinedReference = new s.InterfaceFactory()
        break
      case s.ModelKind.TYPE_ALIAS_CONSTRUCTOR:
        refinedReference = new s.TypeAliasFactory()
        break
      default:
        throw new Error('Unexpected reference type: ' + reference.modelKind)
    }
    refinedReference.typeConstructor = reference

    return refinedReference
  }

  function processSignatureType(declaration: ts.SignatureDeclaration, isDecorable:boolean, parentTypeParameters: s.KeyValue<s.TypeParameterFactory<any>>): s.AbstractFunctionTypeFactory<any, any, any> {
    let functionTypeFactory = isDecorable ? new s.DecoratedFunctionTypeFactory() : new s.FunctionTypeFactory()

    let typeParameters: s.KeyValue<s.TypeParameterFactory<any>>
    if (declaration.typeParameters) {
      typeParameters = processTypeParameters(functionTypeFactory, declaration.typeParameters, parentTypeParameters)
    } else {
      typeParameters = parentTypeParameters
    }

    functionTypeFactory.type = processType(tc.getSignatureFromDeclaration(declaration).getReturnType(), typeParameters)

    declaration.parameters.forEach(function(paramDec: ts.ParameterDeclaration) {
      let parameter = functionTypeFactory.addParameter((<ts.Identifier>paramDec.name).text)
      parameter.type = processNode(paramDec.type || paramDec, typeParameters)
      if (paramDec.questionToken) {
        parameter.optional = true
      }
      if (paramDec.initializer) {
        parameter.initializer = processExpression(paramDec.initializer, typeParameters)
      }

      if (isDecorable) {
        processDecorators(paramDec, parameter, typeParameters)
      }

      return parameter
    })

    return functionTypeFactory
  }

  function populateMembers<MC extends s.AbstractMemberFactory<any, any, any>>(parent: s.AbstractCompositeTypeFactory<any ,MC, any>, nodes: ts.NodeArray<ts.Node>, isDecorable:boolean, typeParameters: s.KeyValue<s.TypeParameterFactory<any>>) {
    nodes.forEach(function(node) {
      switch (node.kind) {
        case ts.SyntaxKind.IndexSignature:
          let index = <ts.IndexSignatureDeclaration>node
          let keyType = <s.PrimitiveTypeFactory>processNode(index.parameters[0].type || index.parameters[0], typeParameters)
          parent.createIndex(keyType.primitiveTypeKind)
          parent.index.valueType = <s.TypeFactory<any>> processNode(index.type, typeParameters)
          break
        case ts.SyntaxKind.ConstructSignature:
          // TODO: Handle
          break
        case ts.SyntaxKind.CallSignature:
          if (!parent.calls) {
            parent.calls = []
          }
          parent.calls.push(processSignatureType(<ts.SignatureDeclaration>node, isDecorable, typeParameters))
          break
        case ts.SyntaxKind.PropertyDeclaration:
        case ts.SyntaxKind.PropertySignature:
          let p = <ts.PropertyDeclaration>node
          let propName = <string>getName(p.name)
          let propMember = parent.addMember(propName)
          propMember.optional = !!p.questionToken
          propMember.type = <s.TypeFactory<any>>processNode(p.type || p, typeParameters)
          if (p.initializer) {
            propMember.initializer = processExpression(p.initializer, typeParameters)
          }
          break
        default:
          let declaration = <ts.Declaration>node
          let name = <string>getName(declaration.name)
          let member = parent.addMember(name)
          member.type = <s.TypeFactory<any>>processNode(node, typeParameters)
          break
      }
    })
  }

  function processVariableDeclaration(varDec:ts.VariableDeclaration, parent:s.ContainerFactory) {
    let valueKind: s.ValueKind = varDec.flags === ts.NodeFlags.Const ? s.ValueKind.CONST : (varDec.flags === ts.NodeFlags.Let ? s.ValueKind.LET : s.ValueKind.VAR)
    let name = getName(varDec.name)
    if (Array.isArray(name)) {
      // TODO
    } else {
      let s = parent.addValue(name)
      s.valueKind = valueKind
      s.type = processType(tc.getTypeAtLocation(varDec), {})
      if (varDec.initializer) {
        s.initializer = processExpression(varDec.initializer, {})
      }
    }
  }

  function populateValue(node:ts.Node, parent:s.ContainerFactory) {
    switch (node.kind) {
      case ts.SyntaxKind.VariableDeclaration:
        let varDec = <ts.VariableDeclaration>node
        processVariableDeclaration(varDec, parent)
        break
      case ts.SyntaxKind.VariableStatement:
        let vars = <ts.VariableStatement>node
        vars.declarationList.declarations.forEach(function(varDec) {
          processVariableDeclaration(varDec, parent)
        })
        break
      case ts.SyntaxKind.FunctionDeclaration:
        let func = <ts.FunctionDeclaration>node
        let valueFactory = parent.addValue(func.name.text)
        valueFactory.valueKind = s.ValueKind.FUNCTION
        valueFactory.type = processSignatureType(func, false, {})
        break
    }
  }

  function populateEnum(enumDec:ts.EnumDeclaration, parent:s.ContainerFactory) {
    let enumFactory = parent.addEnum(enumDec.name.text)
    enumDec.members.forEach(function(member){
      let memberFactory = enumFactory.addMember(<string>getName(member.name))
      if (member.initializer) {
        memberFactory.initializer = processExpression(member.initializer, {})
      }
    })
  }

  function populateInterface(intDec: ts.InterfaceDeclaration, parent: s.AbstractContainerFactory, parentTypeParameters: s.KeyValue<s.TypeParameterFactory<any>>) {
    let intName = intDec.name.text
    let int = parent.addInterfaceConstructor(intName)
    let instanceType = int.createInstanceType()

    let newTypeParameterFactories:s.KeyValue<s.TypeParameterFactory<any>>
    if (intDec.typeParameters) {
      newTypeParameterFactories = processTypeParameters(int, intDec.typeParameters, parentTypeParameters)
    } else {
      newTypeParameterFactories = parentTypeParameters
    }
    //processTypeParameters(int, intDec.typeParameters, newTypeParameterFactories)

    if (intDec.heritageClauses) {
      intDec.heritageClauses.forEach(function(heritageClause: ts.HeritageClause) {
        if (heritageClause.token === ts.SyntaxKind.ExtendsKeyword) {
          int.extends = processHeritageClause(heritageClause, newTypeParameterFactories)
        }
      })
    }

    populateMembers(instanceType, intDec.members, false, newTypeParameterFactories)

    return int
  }

  function populateProtoClass(clsLikeDec: ts.ClassLikeDeclaration, instanceType: s.CompositeTypeFactory<any>, staticType: s.CompositeTypeFactory<any>, isDecorable:boolean, typeParameters: s.KeyValue<s.TypeParameterFactory<any>>) {
    clsLikeDec.members.forEach(function(member: ts.ClassElement) {
      let name: string
      switch (member.kind) {
        case ts.SyntaxKind.IndexSignature:
        let index = <ts.IndexSignatureDeclaration>member
          let keyType = <s.PrimitiveTypeFactory>processNode(index.parameters[0].type, typeParameters)
          instanceType.createIndex(keyType.primitiveTypeKind)
          instanceType.index.valueType = <s.TypeFactory<any>>processNode(index.type, typeParameters)
          break
        case ts.SyntaxKind.Constructor:
          let constructorDec = <ts.ConstructorDeclaration>member
          staticType.calls.push(processSignatureType(constructorDec, isDecorable, typeParameters))
          break
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.PropertyDeclaration:
        case ts.SyntaxKind.GetAccessor:
          let methodDec = <ts.MethodDeclaration | ts.PropertyDeclaration | ts.AccessorDeclaration>member
          let memberFactory = instanceType.addMember((<ts.Identifier>methodDec.name).text)
          memberFactory.type = <s.TypeFactory<any>>processNode(methodDec, typeParameters)
          if (isDecorable) {
            processDecorators(member, <s.DecoratedMemberFactory<any, any>>memberFactory, typeParameters)
          }
          break
      }
    })
  }

  function populateClass(clsDec: ts.ClassDeclaration, parent: s.AbstractContainerFactory, parentTypeParameters: s.KeyValue<s.TypeParameterFactory<any>>) {
    let name = clsDec.name.text
    let cls = parent.addClassConstructor(name)
    let instanceType = cls.createInstanceType()
    let staticType = cls.createStaticType()

    cls.isAbstract = clsDec.modifiers && clsDec.modifiers.filter(modifier=> modifier.kind === ts.SyntaxKind.AbstractKeyword).length === 1

    let newTypeParameterFactories:s.KeyValue<s.TypeParameterFactory<any>>
    if (clsDec.typeParameters) {
      newTypeParameterFactories = processTypeParameters(cls, clsDec.typeParameters, parentTypeParameters)
    } else {
      newTypeParameterFactories = parentTypeParameters
    }

    processDecorators(clsDec, cls, newTypeParameterFactories)

    if (clsDec.heritageClauses) {
      clsDec.heritageClauses.forEach(function(heritageClause: ts.HeritageClause) {
        if (heritageClause.token === ts.SyntaxKind.ImplementsKeyword) {
          cls.implements = processHeritageClause(heritageClause, newTypeParameterFactories)
        } else if (heritageClause.token === ts.SyntaxKind.ExtendsKeyword) {
          cls.extends = <s.ClassFactory>processHeritageClause(heritageClause, newTypeParameterFactories)[0]
        }
      })
    }

    populateProtoClass(clsDec, instanceType, staticType, true, newTypeParameterFactories)

    return cls
  }

  function populateTypeAliasConstructor(aliasDec: ts.TypeAliasDeclaration, parent: s.AbstractContainerFactory, parentTypeParameters: s.KeyValue<s.TypeParameterFactory<any>>) {
    let typeAliasConstructor = parent.addTypeAliasConstructor(aliasDec.name.text)
    let newTypeParameterFactories = processTypeParameters(typeAliasConstructor, aliasDec.typeParameters, parentTypeParameters)
    typeAliasConstructor.type = <s.TypeFactory<any>>processNode(aliasDec.type, newTypeParameterFactories)
  }

  function processHeritageClause(heritageClause: ts.HeritageClause, typeParameters: s.KeyValue<s.TypeParameterFactory<any>>): (s.ClassFactory | s.InterfaceFactory)[] {
    return heritageClause.types.map(function(heritageClauseElement: ts.ExpressionWithTypeArguments) {
      let heritageType = processNode(heritageClauseElement.expression, typeParameters)
      if ((<s.PrimitiveTypeFactory>heritageType).primitiveTypeKind) {
        throw new Error('Reference not found: ' + heritageClauseElement.expression.getText() + ' for constructor ' + (<ts.InterfaceDeclaration>heritageClause.parent).name.text)
      }
      return <s.ClassFactory | s.InterfaceFactory>heritageType
    })
  }

  function processTypeParameters(parent: s.TypeConstructorFactory<any>, typeParameters: ts.TypeParameterDeclaration[], parentTypeParameters: s.KeyValue<s.TypeParameterFactory<any>>):s.KeyValue<s.TypeParameterFactory<any>> {
    let newTypeParameterFactories:s.KeyValue<s.TypeParameterFactory<any>> = {}
    Object.keys(parentTypeParameters).forEach(function(name){
      newTypeParameterFactories[name] = parentTypeParameters[name]
    })
    if (typeParameters) {
      let shouldAdd = parent.typeParameters.length === 0
      typeParameters.forEach(function(typeParameter, i){
        let typeParameterFactory = shouldAdd ? parent.addTypeParameter(typeParameter.name.text) : parent.typeParameters[i]
        if (typeParameter.constraint) {
          typeParameterFactory.extends = <s.TypeFactory<any>>processNode(typeParameter.constraint, parentTypeParameters)
        }
        newTypeParameterFactories[typeParameterFactory.name] = typeParameterFactory
      })
    }
    return newTypeParameterFactories
  }

  function processExpression(expression: ts.Expression, typeParameters: s.KeyValue<s.TypeParameterFactory<any>>): s.AbstractExpressionFactory<any> {
    switch (expression.kind) {
      case ts.SyntaxKind.Identifier:
        let symbol = tc.getSymbolAtLocation(expression)
        if (symbol) {
          let aliasedSymbol = tc.getAliasedSymbol(symbol)
          if (aliasedSymbol && aliasedSymbol.valueDeclaration) {
            switch (aliasedSymbol.valueDeclaration.kind) {
              case ts.SyntaxKind.VariableDeclaration:
              case ts.SyntaxKind.FunctionDeclaration:
              case ts.SyntaxKind.ClassDeclaration:
                let dec = <ts.Declaration>aliasedSymbol.valueDeclaration
                let valueExpression = new s.ValueExpressionFactory()
                valueExpression.value = <s.ValueFactory<any>>getReference(dec, false)
                return valueExpression
            }
          }
        }
        let id = processNode(expression, typeParameters)
        if (id.modelKind === s.ModelKind.CLASS_CONSTRUCTOR) {
          let clsRefExpression = new s.ClassReferenceExpressionFactory()
          clsRefExpression.classReference = <s.ClassConstructorFactory>id
          return clsRefExpression
        } else {
          console.log(id)
          // TODO
          throw 'Unsupported indentifier: ' + expression.getText()
        }
      case ts.SyntaxKind.ClassExpression:
        let classExpression = <ts.ClassExpression>expression
        let clsExpressionsFactory = new s.ClassExpressionFactory()
        let protoClass = clsExpressionsFactory.createClass()

        populateProtoClass(classExpression, protoClass.instanceType, protoClass.staticType, true, typeParameters)
        return clsExpressionsFactory
      case ts.SyntaxKind.FunctionExpression:
        let functionExpression = <ts.FunctionExpression>expression
        let functionExpressionFactory = new s.FunctionExpressionFactory()
        functionExpressionFactory.functionType = processSignatureType(functionExpression, false, typeParameters)
        return functionExpressionFactory
      case ts.SyntaxKind.CallExpression:
        let callExpression = <ts.CallExpression>expression
        let callExpressionFactory = new s.FunctionCallExpressionFactory()
        callExpressionFactory.function = processExpression(callExpression.expression, typeParameters)
        callExpressionFactory.arguments = callExpression.arguments.map(function(arg){
          return processExpression(arg, typeParameters)
        })
        return callExpressionFactory
      case ts.SyntaxKind.StringLiteral:
        return new s.PrimitiveExpressionFactory(s.PrimitiveTypeKind.STRING, (<ts.LiteralExpression>expression).text)
      case ts.SyntaxKind.TrueKeyword:
        return new s.PrimitiveExpressionFactory(s.PrimitiveTypeKind.BOOLEAN, true)
      case ts.SyntaxKind.FalseKeyword:
        return new s.PrimitiveExpressionFactory(s.PrimitiveTypeKind.BOOLEAN, false)
      case ts.SyntaxKind.NumericLiteral:
        return new s.PrimitiveExpressionFactory(s.PrimitiveTypeKind.NUMBER, parseFloat((<ts.LiteralExpression>expression).text))
      case ts.SyntaxKind.ObjectLiteralExpression:
        let objectExpressionFactory = new s.ObjectExpressionFactory()
        let objectLiteral = <ts.ObjectLiteralExpression>expression
        objectLiteral.properties.forEach(function(property) {
          let name = (<ts.Identifier>property.name).text
          let assignment = (<ts.PropertyAssignment>property).initializer
          objectExpressionFactory.addProperty(name, processExpression(assignment, typeParameters))
        })
        return objectExpressionFactory
      case ts.SyntaxKind.ArrayLiteralExpression:
        let arrayExpressionFactory = new s.ArrayExpressionFactory()
        let arrayLiteral = <ts.ArrayLiteralExpression>expression
        arrayLiteral.elements.forEach(function(element) {
          arrayExpressionFactory.addElement(processExpression(element, typeParameters))
        })
        return arrayExpressionFactory
      case ts.SyntaxKind.PropertyAccessExpression:
        let pae = <ts.PropertyAccessExpression>expression
        let name = pae.name.getText()
        if (name) {
          let type = <s.TypeFactory<any>>processNode(pae.name, typeParameters)
          if (type.typeKind === s.TypeKind.ENUM) {
            let e = <s.EnumExpressionFactory>s.expressionFactory(s.ExpressionKind.ENUM)
            e.enum = <s.EnumFactory> type
            e.value = name
            return e
          } else {
            // TODO: This is just temporary
            let e = <s.PrimitiveExpressionFactory<any>>s.expressionFactory(s.ExpressionKind.PRIMITIVE)
            e.primitiveTypeKind = s.PrimitiveTypeKind.ANY
            return e
          }
        }
      case ts.SyntaxKind.NewExpression:
        // TODO
      default:
        let e = <s.PrimitiveExpressionFactory<any>>s.expressionFactory(s.ExpressionKind.PRIMITIVE)
        e.primitiveTypeKind = s.PrimitiveTypeKind.ANY
        return e
        // TODO: This is just temporary
        //throw new Error('Unsupported expression: ' + expression.getText())
    }
  }

  function processDecorators(node: ts.Node, factory: s.DecoratedFactory<any, any>, typeParameters: s.KeyValue<s.TypeParameterFactory<any>>) {
    if (node.decorators) {
      node.decorators.forEach(function(decorator: ts.Decorator) {
        if (decorator.expression.kind === ts.SyntaxKind.Identifier) {
          let id = <ts.Identifier>decorator.expression
          let decoratorType = processNode(id, typeParameters)
          if (!(<s.TypeFactory<any>>decoratorType).typeKind) {
            throw new Error('Reference not found: ' + decorator.expression.getText() + ' for decorator ' + decorator.getText())
          }
          let decoratorFactory = factory.addDecorator()
          decoratorFactory.decoratorType = <s.ValueFactory<any>>decoratorType
        } else if (decorator.expression.kind === ts.SyntaxKind.CallExpression) {
          let call = <ts.CallExpression>decorator.expression
          let decoratorType = processNode(call.expression, typeParameters)
          if ((<s.TypeFactory<any>>decoratorType).typeKind) {
            throw new Error('Reference not found: ' + decorator.expression.getText() + ' for decorator ' + decorator.getText())
          }
          let decoratorFactory = factory.addDecorator()
          decoratorFactory.decoratorType = <s.ValueFactory<any>>decoratorType
          decoratorFactory.parameters = call.arguments.map(function(arg: ts.Expression) {
            return processExpression(arg, typeParameters)
          })
        }
      })
    }
  }

  return moduleFactories
}

interface Globals {
  types: s.KeyValue<ts.Symbol>
  modules: s.KeyValue<ts.Symbol>
  namespaces: s.KeyValue<ts.Symbol>
}

function getGlobals(p: ts.Program): Globals {
  let tc = p.getTypeChecker()
  let libDTS = p.getSourceFiles().filter(function(sf) {
    return sf.fileName.indexOf('/lib.d.ts') === sf.fileName.length - '/lib.d.ts'.length
  })[0]
  let types: s.KeyValue<ts.Symbol> = {}
  let modules: s.KeyValue<ts.Symbol> = {}
  let namespaces: s.KeyValue<ts.Symbol> = {}

  tc.getSymbolsInScope(libDTS, ts.SymbolFlags.Type).forEach(type=> {
    types[type.name] = type
  })
  tc.getSymbolsInScope(libDTS, ts.SymbolFlags.Module).forEach(module=> {
    if (module.name.charAt(0) === '"' || module.name.charAt(0) === '\'') {
      modules[module.name.substring(1, module.name.length - 1)] = module
    } else {
       namespaces[module.name] = module
    }
  })

  return {
    types: types,
    modules: modules,
    namespaces: namespaces
  }
}

function isExported(node: ts.Node):boolean {
  return node.modifiers && node.modifiers.filter(modifier=> modifier.kind === ts.SyntaxKind.ExportKeyword).length > 0
}

// TODO: We need to reconsider this, especially computed property names...
function getName(id: ts.Identifier | ts.LiteralExpression | ts.ComputedPropertyName | ts.BindingPattern): string | string[] {
  switch (id.kind) {
    case ts.SyntaxKind.ComputedPropertyName:
      let computedPropertyName = <ts.ComputedPropertyName>id
      let prop = <ts.PropertyAccessExpression>computedPropertyName.expression
      return (<ts.Identifier>prop.name).text
    case ts.SyntaxKind.ArrayBindingPattern:
    case ts.SyntaxKind.ObjectBindingPattern:
    // TODO
    default:
      return (<ts.Identifier>id).text
  }
}
