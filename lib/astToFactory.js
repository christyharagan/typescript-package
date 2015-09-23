var s = require('typescript-schema');
var ts = require('typescript');
var path = require('path');
var fs = require('fs');
var utils = require('./packageUtils');
function packageAstToFactory(pkgDir, options, host) {
    var allRawModules = {};
    var packageJson = utils.getPackageJson(pkgDir);
    var files = utils.getSourceFilesList(pkgDir);
    files = loadAllFiles(files);
    var pkgs = {};
    var p = ts.createProgram(files, options || { target: 1 }, host);
    p.getSourceFiles().forEach(function (sf) {
        var file = sf.fileName;
        var dirName = path.dirname(file);
        while (true) {
            if (fs.existsSync(path.join(dirName, 'package.json'))) {
                var pkgJson = JSON.parse(fs.readFileSync(path.join(dirName, 'package.json')).toString());
                pkgs[file] = [pkgJson.name, path.relative(pkgDir, dirName).replace(/\\/g, '/')];
                break;
            }
            else {
                dirName = path.dirname(dirName);
            }
            if (dirName === path.join(dirName, '..')) {
                throw new Error('Package not found for file: ' + file);
            }
        }
    });
    function relativePrefix(fileName, moduleName) {
        var pkg = pkgs[fileName];
        return path.posix.join(pkg[0], path.posix.relative(pkg[1], moduleName));
    }
    var packageFactory = new s.PackageFactory();
    packageFactory.modules = moduleAstsToFactory(p, pkgDir, relativePrefix);
    return packageFactory;
}
exports.packageAstToFactory = packageAstToFactory;
function moduleAstsToFactory(p, rootDir, relativePrefix) {
    var moduleFactories = {};
    var globals = getGlobals(p);
    var tc = p.getTypeChecker();
    p.getSourceFiles().forEach(function (sf) {
        processSourceFile(sf);
    });
    function processSourceFile(sf) {
        var moduleNames = [];
        var isModule = false;
        ts.forEachChild(sf, function (node) {
            if (isExported(node) || node.kind === 226) {
                isModule = true;
            }
        });
        if (isModule) {
            var moduleName = utils.fileNameToModuleName(sf.fileName, rootDir, relativePrefix);
            processModule(moduleName, sf, moduleFactories[moduleName]);
            moduleNames.push(moduleName);
        }
        else {
            moduleNames = moduleNames.concat(processDeclarationFile(sf));
        }
        return moduleNames;
    }
    function processModule(moduleName, moduleNode, module, isDeclared) {
        if (!module) {
            module = new s.ModuleFactory(moduleName);
        }
        moduleFactories[moduleName] = module;
        processContainer(module, moduleNode, isDeclared);
        return module;
    }
    function processDeclarationFile(declarationFile) {
        var globalModule = moduleFactories[''];
        if (!globalModule) {
            globalModule = new s.ModuleFactory('');
            moduleFactories[''] = globalModule;
        }
        return processContainer(globalModule, declarationFile, true);
    }
    function processExport(container, node) {
        switch (node.kind) {
            case 191:
                var vars = node;
                var valueKind = vars.declarationList.flags === 32768 ? s.ValueKind.CONST : (vars.declarationList.flags === 16384 ? s.ValueKind.LET : s.ValueKind.VAR);
                vars.declarationList.declarations.forEach(function (varDec) {
                    var name = getName(varDec.name);
                    if (Array.isArray(name)) {
                    }
                    else {
                        var s_1 = container.addValue(name);
                        s_1.valueKind = valueKind;
                        s_1.type = processType(tc.getTypeAtLocation(varDec), {});
                        if (varDec.initializer) {
                            s_1.initializer = processExpression(varDec.initializer, {});
                        }
                    }
                });
                break;
            case 213:
                populateInterface(node, container, {});
                break;
            case 212:
                populateClass(node, container, {});
                break;
            case 215:
                var enumDec = node;
                var enumFactory = container.addEnum(enumDec.name.text);
                enumDec.members.forEach(function (member) {
                    var memberFactory = enumFactory.addMember(getName(member.name));
                    if (member.initializer) {
                        memberFactory.initializer = processExpression(member.initializer, {});
                    }
                });
                break;
            case 214:
                populateTypeAliasConstructor(node, container, {});
                break;
            case 211:
                var func = node;
                var valueFactory = container.addValue(func.name.text);
                valueFactory.valueKind = s.ValueKind.FUNCTION;
                valueFactory.type = processSignatureType(func, false, {});
                break;
        }
    }
    function addReference(ref, name, typeContainer) {
        switch (ref.modelKind) {
            case s.ModelKind.CLASS_CONSTRUCTOR:
                typeContainer.classConstructors[name] = ref;
                return;
            case s.ModelKind.INTERFACE_CONSTRUCTOR:
                typeContainer.interfaceConstructors[name] = ref;
                return;
            case s.ModelKind.TYPE_ALIAS_CONSTRUCTOR:
                typeContainer.typeAliasConstructors[name] = ref;
                return;
            case s.ModelKind.VALUE:
                typeContainer.values[name] = ref;
                return;
            case s.ModelKind.TYPE:
                typeContainer.enums[name] = ref;
                return;
        }
    }
    function processSymbolTable(typeContainer, symbolTable) {
        Object.keys(symbolTable).forEach(function (name) {
            var symbol = symbolTable[name];
            if (symbol && symbol.declarations) {
                symbol.declarations.forEach(function (dec) {
                    if (dec.kind === 226) {
                        var exportDec = dec;
                        processSymbolTable(typeContainer, tc.getSymbolAtLocation(exportDec.moduleSpecifier).exports);
                    }
                    else if (dec.kind === 225) {
                        var exportAssignment = dec;
                        var exportSymbol = tc.getSymbolAtLocation(exportAssignment.expression);
                        var exportType = tc.getTypeAtLocation(exportAssignment.expression);
                        if (exportType && exportType.symbol && exportType.symbol.exports) {
                            processSymbolTable(typeContainer, exportType.symbol.exports || exportType.symbol.members);
                        }
                        else if (exportSymbol.exports) {
                            processSymbolTable(typeContainer, exportSymbol.exports);
                        }
                        else {
                            var importDec = exportSymbol.declarations[0];
                            processSymbolTable(typeContainer, tc.getTypeAtLocation(importDec).symbol.exports || tc.getTypeAtLocation(importDec).symbol.members);
                        }
                    }
                    else {
                        if (dec.kind !== 145) {
                            addReference(getReference(dec, dec.kind === 216), name, typeContainer);
                        }
                    }
                });
            }
        });
    }
    function processContainer(container, node, isDeclaredModule) {
        var moduleNames = [];
        ts.forEachChild(node, function (child) {
            switch (child.kind) {
                case 225:
                    var exportAssignment = child;
                    var exportSymbol = tc.getSymbolAtLocation(exportAssignment.expression);
                    var exportType = tc.getTypeAtLocation(exportAssignment.expression);
                    if (exportType && exportType.symbol && exportType.symbol.exports) {
                        processSymbolTable(container, exportType.symbol.exports || exportType.symbol.members);
                    }
                    else if (exportSymbol.exports) {
                        processSymbolTable(container, exportSymbol.exports);
                    }
                    else {
                        var importDec = exportSymbol.declarations[0];
                        processSymbolTable(container, tc.getTypeAtLocation(importDec).symbol.exports || tc.getTypeAtLocation(importDec).symbol.members);
                    }
                    break;
                case 226:
                    var exportDec = child;
                    var exportClause = exportDec.exportClause;
                    if (exportClause) {
                        exportDec.exportClause.elements.forEach(function (element) {
                            addReference(getReference(tc.getSymbolAtLocation(element), false), element.name.text, container);
                        });
                    }
                    processSymbolTable(container, tc.getSymbolAtLocation(exportDec.moduleSpecifier).exports || tc.getSymbolAtLocation(exportDec.moduleSpecifier).members);
                    break;
                default:
                    if (isDeclaredModule || moduleFactories[''] === container || isExported(child)) {
                        switch (child.kind) {
                            case 216:
                                var modDec = child;
                                var name_1 = modDec.name.text;
                                var symbol = tc.getTypeAtLocation(modDec).symbol;
                                if (moduleFactories[''] === container && symbol && (symbol.name.charAt(0) === '"' || symbol.name.charAt(0) === '\'')) {
                                    ts.forEachChild(modDec, function (child) {
                                        if (child.kind === 217) {
                                            processModule(name_1, child, moduleFactories[name_1], true);
                                            moduleNames.push(name_1);
                                        }
                                    });
                                }
                                else {
                                    var namespace = container.addNamespace(name_1);
                                    ts.forEachChild(modDec, function (child) {
                                        if (child.kind === 217) {
                                            processContainer(namespace, child, isDeclaredModule);
                                        }
                                    });
                                }
                                break;
                            default:
                                processExport(container, child);
                        }
                    }
            }
        });
        return moduleNames;
    }
    function getReference(symbolOrDec, isModule) {
        var containerFactory;
        var isGlobal = false;
        var dec;
        var name;
        if (symbolOrDec.kind) {
            dec = symbolOrDec;
            name = getName(dec.name);
            var globalSymbol = globals.types[name];
            isGlobal = !isModule && globalSymbol && globalSymbol.declarations[0] === dec;
        }
        else {
            var symbol = symbolOrDec;
            var i = 0;
            dec = symbol.declarations[0];
            while (dec.kind === 209 && (i + 1) < symbol.declarations.length) {
                i++;
                dec = symbol.declarations[i];
            }
            name = symbol.name;
            isGlobal = !isModule && globals.types[name] === symbol;
        }
        if (isGlobal) {
            containerFactory = moduleFactories[''];
            if (!containerFactory) {
                containerFactory = new s.ModuleFactory('');
                moduleFactories[''] = containerFactory;
            }
        }
        else {
            var moduleName;
            var names = [];
            var previousName;
            var node = isModule ? dec : dec.parent;
            while (node.kind !== 246) {
                switch (node.kind) {
                    case 216:
                        var mod = node;
                        if (node.parent.kind === 246 && globals.modules[mod.name.text]) {
                            moduleName = mod.name.text;
                            break;
                        }
                        else {
                            previousName = mod.name.text;
                            names.splice(0, 0, mod.name.text);
                        }
                }
                node = node.parent;
            }
            if (moduleName) {
                if (relativePrefix && moduleName.substring(0, 2) === './') {
                    if (relativePrefix.charAt) {
                        moduleName = path.posix.join(relativePrefix, moduleName);
                    }
                    else {
                        moduleName = relativePrefix(node.fileName, moduleName);
                    }
                }
            }
            else if (globals.namespaces[previousName] || node.fileName.substring(node.fileName.length - 8) === 'lib.d.ts') {
                moduleName = '';
            }
            else {
                moduleName = utils.fileNameToModuleName(node.fileName, rootDir, relativePrefix);
            }
            containerFactory = moduleFactories[moduleName];
            if (!containerFactory) {
                containerFactory = new s.ModuleFactory(moduleName);
                moduleFactories[moduleName] = containerFactory;
            }
            names.forEach(function (name) {
                containerFactory = containerFactory.addNamespace(name);
            });
        }
        if (isModule) {
            return containerFactory;
        }
        else {
            switch (dec.kind) {
                case 213:
                    return containerFactory.addInterfaceConstructor(name);
                case 212:
                    return containerFactory.addClassConstructor(name);
                case 215:
                    return containerFactory.addEnum(name);
                case 214:
                    return containerFactory.addTypeAliasConstructor(name);
                case 211:
                    return containerFactory.addValue(name);
                case 209:
                    var varDec = dec;
                    return containerFactory.addValue(name);
                case 216:
                    return containerFactory;
                default:
                    throw new Error('Unrecognised declaration kind: ' + dec.kind + ' with text: ' + dec.getText());
            }
        }
    }
    function processNode(node, typeParameters) {
        var isTypeQuery = node.kind === 152;
        if (isTypeQuery) {
            var typeQuery = node;
            var typeSymbol = tc.getSymbolAtLocation(typeQuery.exprName);
            var typeQueryFactory = new s.TypeQueryFactory();
            if (!typeSymbol || !typeSymbol.declarations) {
                return typeQueryFactory;
            }
            else {
                var ref;
                var typeSymbolDec = typeSymbol.declarations[0];
                switch (typeSymbolDec.kind) {
                    case 216:
                        ref = getReference(typeSymbol, true);
                    case 209:
                    case 211:
                        ref = getReference(typeSymbol, false);
                    default:
                        var type = tc.getTypeAtLocation(node);
                        if (!type.symbol) {
                            ref = getReference(typeSymbol, false);
                        }
                        else {
                            var declaration = type.symbol.declarations[0];
                            if (declaration && declaration.kind === 216) {
                                ref = getReference(type.symbol, true);
                            }
                            else {
                                ref = processType(type, typeParameters);
                            }
                        }
                }
                typeQueryFactory.type = ref;
                return typeQueryFactory;
            }
        }
        else {
            var type = tc.getTypeAtLocation(node);
            if (type.typeParameters) {
                var typeArgNode = (node).kind === 67 ? (node).parent : (node);
                if (typeArgNode.kind === 154) {
                    var arrayType = typeArgNode;
                    var arrayConstructorFactory = moduleFactories[''].addInterfaceConstructor('Array');
                    var arrayFactory = new s.InterfaceFactory();
                    arrayFactory.typeConstructor = arrayConstructorFactory;
                    arrayFactory.typeArguments.push(processNode(arrayType.elementType, typeParameters));
                    return arrayFactory;
                }
                else {
                    var typeArguments = typeArgNode.typeArguments;
                    var reference;
                    if (!type.symbol && tc.getSymbolAtLocation(node)) {
                        reference = getReference(tc.getSymbolAtLocation(node), false);
                    }
                    else {
                        reference = processType(type, typeParameters);
                        if (reference.modelKind === s.ModelKind.TYPE) {
                            reference = reference.typeConstructor;
                        }
                    }
                    var refinedReference;
                    switch (reference.modelKind) {
                        case s.ModelKind.CLASS_CONSTRUCTOR:
                            refinedReference = new s.ClassFactory();
                            break;
                        case s.ModelKind.INTERFACE_CONSTRUCTOR:
                            refinedReference = new s.InterfaceFactory();
                            break;
                        case s.ModelKind.TYPE_ALIAS_CONSTRUCTOR:
                            refinedReference = new s.TypeAliasFactory();
                            break;
                        default:
                            throw new Error('Unexpected expression with type arguments: ' + typeArgNode.getText());
                    }
                    refinedReference.typeConstructor = reference;
                    refinedReference.typeArguments = typeArguments.map(function (typeArg) {
                        return processNode(typeArg, typeParameters);
                    });
                    return refinedReference;
                }
            }
            else if (!type.symbol && tc.getSymbolAtLocation(node)) {
                return closeReference(getReference(tc.getSymbolAtLocation(node), false));
            }
            else {
                return processType(type, typeParameters);
            }
        }
    }
    function processType(type, typeParameters) {
        var reference;
        switch (type.flags) {
            case 1:
                return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.ANY);
            case 2:
            case 256:
                return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.STRING);
            case 4:
                return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.NUMBER);
            case 8:
                return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.BOOLEAN);
            case 16:
                return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.VOID);
            case 16777216:
                return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.SYMBOL);
            case 128:
                return getReference(type.symbol, false);
            case 1024:
            case 2048:
            case 4096 + 1024:
            case 4096 + 2048:
                reference = getReference(type.symbol, false);
                break;
            case 512:
                if (!typeParameters[type.symbol.name]) {
                    throw new Error('Type parameter not found: ' + type.symbol.name);
                }
                else {
                    return typeParameters[type.symbol.name];
                }
            case 8192:
                var tupleType = type;
                var tupleTypeFactory = new s.TupleTypeFactory();
                tupleTypeFactory.elements = tupleType.elementTypes.map(function (elementType) {
                    return processType(elementType, typeParameters);
                });
                return tupleTypeFactory;
            case 16384:
                var unionType = type;
                var unionTypeFactory = new s.UnionOrIntersectionTypeFactory(s.TypeKind.UNION);
                unionTypeFactory.types = unionType.types.map(function (type) {
                    return processType(type, typeParameters);
                });
                return unionTypeFactory;
            case 32768:
                var intersectionType = type;
                var intersectionTypeFactory = new s.UnionOrIntersectionTypeFactory(s.TypeKind.INTERSECTION);
                intersectionTypeFactory.types = unionType.types.map(function (type) {
                    return processType(type, typeParameters);
                });
                return intersectionTypeFactory;
            case 4096:
            case (4096 + 2048):
                var referenceType = type;
                reference = getReference(referenceType.target.symbol, false);
                break;
            case 65536:
                var declaration = type.symbol.declarations[0];
                switch (declaration.kind) {
                    case 211:
                        return getReference(declaration, false);
                    case 171:
                    case 150:
                    case 140:
                    case 151:
                        return processSignatureType(declaration, false, typeParameters);
                    case 141:
                        return processSignatureType(declaration, true, typeParameters);
                    case 212:
                    case 142:
                        reference = getReference(type.symbol, false);
                        break;
                    case 163:
                        var literalCompositeType = new s.CompositeTypeFactory(null, false);
                        var ole = declaration;
                        ole.properties.forEach(function (property) {
                            var member = literalCompositeType.addMember(getName(property.name));
                            member.type = processNode(property, typeParameters);
                        });
                        return literalCompositeType;
                    case 153:
                        var typeLiteral = declaration;
                        var compositeType = new s.CompositeTypeFactory(null, false);
                        populateMembers(compositeType, typeLiteral.members, false, typeParameters);
                        return compositeType;
                    default:
                        throw new Error('Unrecognised Type: ' + type.flags + ' with declaration type: ' + declaration.kind);
                }
                break;
            default:
                throw new Error('Unrecognised Type: ' + type.flags);
        }
        return closeReference(reference);
    }
    function closeReference(reference) {
        var refinedReference;
        switch (reference.modelKind) {
            case s.ModelKind.CLASS_CONSTRUCTOR:
                refinedReference = new s.ClassFactory();
                break;
            case s.ModelKind.INTERFACE_CONSTRUCTOR:
                refinedReference = new s.InterfaceFactory();
                break;
            case s.ModelKind.TYPE_ALIAS_CONSTRUCTOR:
                refinedReference = new s.TypeAliasFactory();
                break;
            default:
                throw new Error('Unexpected reference type: ' + reference.modelKind);
        }
        refinedReference.typeConstructor = reference;
        refinedReference.typeArguments = reference.typeParameters.map(function () {
            return new s.PrimitiveTypeFactory(s.PrimitiveTypeKind.ANY);
        });
        return refinedReference;
    }
    function processSignatureType(declaration, isDecorable, parentTypeParameters) {
        var functionTypeFactory = isDecorable ? new s.DecoratedFunctionTypeFactory() : new s.FunctionTypeFactory();
        var typeParameters;
        if (declaration.typeParameters) {
            typeParameters = processTypeParameters(functionTypeFactory, declaration.typeParameters, parentTypeParameters);
        }
        else {
            typeParameters = parentTypeParameters;
        }
        functionTypeFactory.type = (!declaration.type || declaration.type.kind === 101) ? undefined : processNode(declaration.type, typeParameters);
        declaration.parameters.forEach(function (paramDec) {
            var parameter = functionTypeFactory.addParameter(paramDec.name.text);
            parameter.type = processNode(paramDec.type || paramDec, typeParameters);
            if (paramDec.questionToken) {
                parameter.optional = true;
            }
            if (paramDec.initializer) {
                parameter.initializer = processExpression(paramDec.initializer, typeParameters);
            }
            if (isDecorable) {
                processDecorators(paramDec, parameter, typeParameters);
            }
            return parameter;
        });
        return functionTypeFactory;
    }
    function populateMembers(parent, nodes, isDecorable, typeParameters) {
        nodes.forEach(function (node) {
            switch (node.kind) {
                case 147:
                    var index = node;
                    var keyType = processNode(index.parameters[0].type || index.parameters[0], typeParameters);
                    parent.createIndex(keyType.primitiveTypeKind);
                    parent.index.valueType = processNode(index.type, typeParameters);
                    break;
                case 146:
                    break;
                case 145:
                    if (!parent.calls) {
                        parent.calls = [];
                    }
                    parent.calls.push(processSignatureType(node, isDecorable, typeParameters));
                    break;
                case 139:
                case 138:
                    var p_1 = node;
                    var propName = getName(p_1.name);
                    parent.members[propName] = {
                        optional: !!p_1.questionToken,
                        type: processNode(p_1.type, typeParameters)
                    };
                    break;
                default:
                    var declaration = node;
                    var name_2 = getName(declaration.name);
                    parent.members[name_2] = {
                        type: processNode(node, typeParameters)
                    };
            }
        });
    }
    function populateInterface(intDec, parent, parentTypeParameters) {
        var intName = intDec.name.text;
        var int = parent.addInterfaceConstructor(intName);
        var instanceType = int.createInstanceType();
        var newTypeParameterFactories;
        if (intDec.typeParameters) {
            newTypeParameterFactories = processTypeParameters(int, intDec.typeParameters, parentTypeParameters);
        }
        else {
            newTypeParameterFactories = parentTypeParameters;
        }
        if (intDec.heritageClauses) {
            intDec.heritageClauses.forEach(function (heritageClause) {
                if (heritageClause.token === 81) {
                    int.extends = processHeritageClause(heritageClause, newTypeParameterFactories);
                }
            });
        }
        processTypeParameters(int, intDec.typeParameters, newTypeParameterFactories);
        populateMembers(instanceType, intDec.members, false, newTypeParameterFactories);
        return int;
    }
    function populateProtoClass(clsLikeDec, instanceType, staticType, isDecorable, typeParameters) {
        clsLikeDec.members.forEach(function (member) {
            var name;
            switch (member.kind) {
                case 147:
                    var index = member;
                    var keyType = processNode(index.parameters[0].type, typeParameters);
                    instanceType.createIndex(keyType.primitiveTypeKind);
                    instanceType.index.valueType = processNode(index.type, typeParameters);
                    break;
                case 142:
                    var constructorDec = member;
                    staticType.calls.push(processSignatureType(constructorDec, isDecorable, typeParameters));
                    break;
                case 141:
                case 139:
                case 143:
                    var methodDec = member;
                    var memberFactory = instanceType.addMember(methodDec.name.text);
                    memberFactory.type = processNode(methodDec, typeParameters);
                    if (isDecorable) {
                        processDecorators(member, memberFactory, typeParameters);
                    }
                    break;
            }
        });
    }
    function populateClass(clsDec, parent, parentTypeParameters) {
        var name = clsDec.name.text;
        var cls = parent.addClassConstructor(name);
        var instanceType = cls.createInstanceType();
        var staticType = cls.createStaticType();
        cls.isAbstract = clsDec.modifiers.filter(function (modifier) { return modifier.kind === 113; }).length === 1;
        var newTypeParameterFactories;
        if (clsDec.typeParameters) {
            newTypeParameterFactories = processTypeParameters(cls, clsDec.typeParameters, parentTypeParameters);
        }
        else {
            newTypeParameterFactories = parentTypeParameters;
        }
        processDecorators(clsDec, cls, newTypeParameterFactories);
        if (clsDec.heritageClauses) {
            clsDec.heritageClauses.forEach(function (heritageClause) {
                if (heritageClause.token === 104) {
                    cls.implements = processHeritageClause(heritageClause, newTypeParameterFactories);
                }
                else if (heritageClause.token === 81) {
                    cls.extends = processHeritageClause(heritageClause, newTypeParameterFactories)[0];
                }
            });
        }
        populateProtoClass(clsDec, instanceType, staticType, true, newTypeParameterFactories);
        return cls;
    }
    function populateTypeAliasConstructor(aliasDec, parent, parentTypeParameters) {
        var typeAliasConstructor = parent.addTypeAliasConstructor(aliasDec.name.text);
        var newTypeParameterFactories = processTypeParameters(typeAliasConstructor, aliasDec.typeParameters, parentTypeParameters);
        typeAliasConstructor.type = processNode(aliasDec.type, newTypeParameterFactories);
    }
    function processHeritageClause(heritageClause, typeParameters) {
        return heritageClause.types.map(function (heritageClauseElement) {
            var heritageType = processNode(heritageClauseElement.expression, typeParameters);
            if (heritageType.primitiveTypeKind) {
                throw new Error('Reference not found: ' + heritageClauseElement.expression.getText() + ' for constructor ' + heritageClause.parent.name.text);
            }
            return heritageType;
        });
    }
    function processTypeParameters(parent, typeParameters, parentTypeParameters) {
        var newTypeParameterFactories = {};
        Object.keys(parentTypeParameters).forEach(function (name) {
            newTypeParameterFactories[name] = parentTypeParameters[name];
        });
        if (typeParameters) {
            typeParameters.forEach(function (typeParameter) {
                var typeParameterFactory = parent.addTypeParameter(typeParameter.name.text);
                if (typeParameter.constraint) {
                    typeParameterFactory.extends = processNode(typeParameter.constraint, parentTypeParameters);
                }
                newTypeParameterFactories[typeParameterFactory.name] = typeParameterFactory;
            });
        }
        return newTypeParameterFactories;
    }
    function processExpression(expression, typeParameters) {
        switch (expression.kind) {
            case 67:
                var cls = processNode(expression, typeParameters);
                var clsRefExpression = new s.ClassReferenceExpressionFactory();
                clsRefExpression.classReference = processNode(expression, typeParameters);
            case 184:
                var classExpression = expression;
                var clsExpressionsFactory = new s.ClassExpressionFactory();
                var protoClass = clsExpressionsFactory.createClass();
                populateProtoClass(classExpression, protoClass.instanceType, protoClass.staticType, true, typeParameters);
                return clsExpressionsFactory;
            case 171:
                var functionExpression = expression;
                var functionExpressionFactory = new s.FunctionExpressionFactory();
                functionExpressionFactory.functionType = processSignatureType(functionExpression, false, typeParameters);
                return functionExpressionFactory;
            case 166:
                var callExpression = expression;
                var callExpressionFactory = new s.FunctionCallExpressionFactory();
                callExpressionFactory.function = processExpression(callExpression.expression, typeParameters);
                callExpressionFactory.arguments = callExpression.arguments.map(function (arg) {
                    return processExpression(arg, typeParameters);
                });
                return callExpressionFactory;
            case 9:
                return new s.PrimitiveExpressionFactory(s.PrimitiveTypeKind.STRING, expression.text);
            case 97:
                return new s.PrimitiveExpressionFactory(s.PrimitiveTypeKind.BOOLEAN, true);
            case 82:
                return new s.PrimitiveExpressionFactory(s.PrimitiveTypeKind.BOOLEAN, false);
            case 8:
                return new s.PrimitiveExpressionFactory(s.PrimitiveTypeKind.NUMBER, parseFloat(expression.text));
            case 163:
                var objectExpressionFactory = new s.ObjectExpressionFactory();
                var objectLiteral = expression;
                objectLiteral.properties.forEach(function (property) {
                    var name = property.name.text;
                    var assignment = property.initializer;
                    objectExpressionFactory.addProperty(name, processExpression(assignment, typeParameters));
                });
                return objectExpressionFactory;
            case 162:
                var arrayExpressionFactory = new s.ArrayExpressionFactory();
                var arrayLiteral = expression;
                arrayLiteral.elements.forEach(function (element) {
                    arrayExpressionFactory.addElement(processExpression(element, typeParameters));
                });
                return arrayExpressionFactory;
            case 164:
                var pae = expression;
                var name_3 = pae.name.getText();
                if (name_3) {
                    var type = processNode(pae.name, typeParameters);
                    if (type.typeKind === s.TypeKind.ENUM) {
                        var e = s.expressionFactory(s.ExpressionKind.ENUM);
                        e.enum = type;
                        return e;
                    }
                    else {
                    }
                }
            default:
                throw 'Unsupported expression';
        }
    }
    function processDecorators(node, factory, typeParameters) {
        if (node.decorators) {
            node.decorators.forEach(function (decorator) {
                if (decorator.expression.kind === 67) {
                    var id = decorator.expression;
                    var decoratorType = processNode(id, typeParameters);
                    if (!decoratorType.typeKind) {
                        throw new Error('Reference not found: ' + decorator.expression.getText() + ' for decorator ' + decorator.getText());
                    }
                    var decoratorFactory = factory.addDecorator();
                    decoratorFactory.decoratorType = decoratorType;
                }
                else if (decorator.expression.kind === 166) {
                    var call = decorator.expression;
                    var decoratorType = processNode(call.expression, typeParameters);
                    if (decoratorType.typeKind) {
                        throw new Error('Reference not found: ' + decorator.expression.getText() + ' for decorator ' + decorator.getText());
                    }
                    var decoratorFactory = factory.addDecorator();
                    decoratorFactory.decoratorType = decoratorType;
                    decoratorFactory.parameters = call.arguments.map(function (arg) {
                        return processExpression(arg, typeParameters);
                    });
                }
            });
        }
    }
    return moduleFactories;
}
exports.moduleAstsToFactory = moduleAstsToFactory;
function getGlobals(p) {
    var tc = p.getTypeChecker();
    var libDTS = p.getSourceFiles().filter(function (sf) {
        return sf.fileName.indexOf('/lib.d.ts') === sf.fileName.length - '/lib.d.ts'.length;
    })[0];
    var types = {};
    var modules = {};
    var namespaces = {};
    tc.getSymbolsInScope(libDTS, 793056).forEach(function (type) {
        types[type.name] = type;
    });
    tc.getSymbolsInScope(libDTS, 1536).forEach(function (module) {
        if (module.name.charAt(0) === '"' || module.name.charAt(0) === '\'') {
            modules[module.name.substring(1, module.name.length - 1)] = module;
        }
        else {
            namespaces[module.name] = module;
        }
    });
    return {
        types: types,
        modules: modules,
        namespaces: namespaces
    };
}
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
function isExported(node) {
    return node.modifiers && node.modifiers.filter(function (modifier) { return modifier.kind === 80; }).length > 0;
}
function getName(id) {
    switch (id.kind) {
        case 134:
            var computedPropertyName = id;
            var prop = computedPropertyName.expression;
            return prop.name.text;
        case 160:
        case 159:
        default:
            return id.text;
    }
}
//# sourceMappingURL=astToFactory.js.map