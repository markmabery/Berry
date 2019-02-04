import {Installer, Linker, LinkOptions, MinimalLinkOptions, Manifest, LinkType, MessageName, DependencyMeta} from '@berry/core';
import {FetchResult, Ident, Locator, Package}                                                                from '@berry/core';
import {miscUtils, structUtils}                                                                              from '@berry/core';
import {CwdFS, FakeFS, NodeFS}                                                                               from '@berry/fslib';
import {PackageInformationStores, LocationBlacklist, generatePnpScript}                                      from '@berry/pnp';
import {posix}                                                                                               from 'path';

// Some packages do weird stuff and MUST be unplugged. I don't like them.
const FORCED_UNPLUG_PACKAGES = new Set([
  structUtils.makeIdent(null, `node-pre-gyp`).identHash,
]);

export class PnpLinker implements Linker {
  supportsPackage(pkg: Package, opts: MinimalLinkOptions) {
    return true;
  }

  async findPackageLocation(locator: Locator, opts: LinkOptions) {
    const fs = new NodeFS();

    const pnpPath = opts.project.configuration.get(`pnpPath`);
    if (!await fs.existsPromise(pnpPath))
      throw new Error(`Couldn't find the PnP package map at the root of the project - run an install to generate it`);

    const pnpFile = miscUtils.dynamicRequire(pnpPath);
    delete require.cache[pnpPath];

    const packageLocator = {name: structUtils.requirableIdent(locator), reference: locator.reference};
    const packageInformation = pnpFile.getPackageInformation(packageLocator);

    if (!packageInformation)
      throw new Error(`Couldn't find ${structUtils.prettyLocator(opts.project.configuration, locator)} in the currently installed pnp map`);

    return packageInformation.packageLocation;
  }

  async findPackageLocator(location: string, opts: LinkOptions) {
    const fs = new NodeFS();

    const pnpPath = opts.project.configuration.get(`pnpPath`);
    if (!await fs.existsPromise(pnpPath))
      throw new Error(`Couldn't find the PnP package map at the root of the project - run an install to generate it`);

    const pnpFile = miscUtils.dynamicRequire(pnpPath);
    delete require.cache[pnpPath];

    const locator = pnpFile.findPackageLocator(location);
    if (!locator)
      return null;

    return structUtils.makeLocator(structUtils.parseIdent(locator.name), locator.reference);
  }

  makeInstaller(opts: LinkOptions) {
    return new PnpInstaller(opts);
  }
}

class PnpInstaller implements Installer {
  private readonly packageInformationStores: PackageInformationStores = new Map();
  private readonly unpluggedPaths: Set<string> = new Set();

  private readonly opts: LinkOptions;

  constructor(opts: LinkOptions) {
    this.opts = opts;
  }

  async installPackage(pkg: Package, fetchResult: FetchResult) {
    const key1 = structUtils.requirableIdent(pkg);
    const key2 = pkg.reference;

    const buildScripts = await this.getBuildScripts(fetchResult);

    if (buildScripts.length > 0 && !this.opts.project.configuration.get(`enableScripts`)) {
      this.opts.report.reportWarning(MessageName.DISABLED_BUILD_SCRIPTS, `${structUtils.prettyLocator(this.opts.project.configuration, pkg)} lists build scripts, but all build scripts have been disabled.`);
      buildScripts.length = 0;
    }

    if (buildScripts.length > 0 && pkg.linkType !== LinkType.HARD) {
      this.opts.report.reportWarning(MessageName.SOFT_LINK_BUILD, `${structUtils.prettyLocator(this.opts.project.configuration, pkg)} lists build scripts, but is referenced through a soft link. Soft links don't support build scripts, so they'll be ignored.`);
      buildScripts.length = 0;
    }
    
    const dependencyMeta = this.opts.project.getDependencyMeta(pkg, pkg.version);

    if (buildScripts.length > 0 && dependencyMeta && dependencyMeta.built === false) {
      this.opts.report.reportInfo(MessageName.BUILD_DISABLED, `${structUtils.prettyLocator(this.opts.project.configuration, pkg)} lists build scripts, but its build has been explicitly disabled through configuration.`);
      buildScripts.length = 0;
    }

    const packageFs = pkg.linkType !== LinkType.SOFT && (buildScripts.length > 0 || this.isUnplugged(pkg, dependencyMeta))
      ? await this.unplugPackage(pkg, fetchResult.packageFs)
      : fetchResult.packageFs;

    const packageRawLocation = posix.resolve(packageFs.getRealPath(), posix.relative(`/`, fetchResult.prefixPath));

    const packageLocation = this.normalizeDirectoryPath(packageRawLocation);
    const packageDependencies = new Map();

    const packageInformationStore = this.getPackageInformationStore(key1);
    packageInformationStore.set(key2, {packageLocation, packageDependencies});

    return {
      packageLocation,
      buildDirective: buildScripts.length > 0 ? {
        scriptNames: buildScripts,
      } : null,
    };
  }

  async attachInternalDependencies(locator: Locator, dependencies: Array<Locator>) {
    const packageInformation = this.getPackageInformation(locator);

    packageInformation.packageDependencies = new Map(dependencies.map(dependency => {
      return [structUtils.requirableIdent(dependency), dependency.reference];
    }) as Array<[string, string]>);
  }

  async attachExternalDependents(locator: Locator, dependentPaths: Array<string>) {
    for (const dependentPath of dependentPaths) {
      const packageInformation = this.getDiskInformation(dependentPath);
      packageInformation.packageDependencies.set(structUtils.requirableIdent(locator), locator.reference);
    }
  }

  async finalizeInstall() {
    this.packageInformationStores.set(null, new Map([
      [null, this.getPackageInformation(this.opts.project.topLevelWorkspace.anchoredLocator)],
    ]));

    const shebang = this.opts.project.configuration.get(`pnpShebang`);
    const ignorePattern = this.opts.project.configuration.get(`pnpIgnorePattern`);
    const blacklistedLocations: LocationBlacklist = new Set();
    const packageInformationStores = this.packageInformationStores;

    const pnpPath = this.opts.project.configuration.get(`pnpPath`);
    const pnpScript = generatePnpScript({shebang, ignorePattern, blacklistedLocations, packageInformationStores});

    const fs = new NodeFS();
    await fs.changeFilePromise(pnpPath, pnpScript);
    await fs.chmodPromise(pnpPath, 0o755);

    const pnpUnpluggedFolder = this.opts.project.configuration.get(`pnpUnpluggedFolder`);
    if (this.unpluggedPaths.size === 0) {
      await fs.removePromise(pnpUnpluggedFolder);
    } else {
      for (const entry of await fs.readdirPromise(pnpUnpluggedFolder)) {
        const unpluggedPath = posix.resolve(pnpUnpluggedFolder, entry);
        if (!this.unpluggedPaths.has(unpluggedPath)) {
          await fs.removePromise(unpluggedPath);
        }
      }
    }
  }

  private getPackageInformationStore(key: string) {
    let packageInformationStore = this.packageInformationStores.get(key);

    if (!packageInformationStore)
      this.packageInformationStores.set(key, packageInformationStore = new Map());

    return packageInformationStore;
  }

  private getPackageInformation(locator: Locator) {
    const key1 = structUtils.requirableIdent(locator);
    const key2 = locator.reference;

    const packageInformationStore = this.packageInformationStores.get(key1);
    if (!packageInformationStore)
      throw new Error(`Assertion failed: The package information store should have been available (for ${structUtils.prettyIdent(this.opts.project.configuration, locator)})`);

    const packageInformation = packageInformationStore.get(key2);
    if (!packageInformation)
      throw new Error(`Assertion failed: The package information should have been available (for ${structUtils.prettyLocator(this.opts.project.configuration, locator)})`);
    
    return packageInformation;
  }

  private getDiskInformation(path: string) {
    const packageInformationStore = this.getPackageInformationStore(`@@disk`);
    const normalizedPath = this.normalizeDirectoryPath(path);

    let diskInformation = packageInformationStore.get(normalizedPath);

    if (!diskInformation) {
      packageInformationStore.set(normalizedPath, diskInformation = {
        packageLocation: normalizedPath,
        packageDependencies: new Map(),
      });
    }

    return diskInformation;
  }

  private normalizeDirectoryPath(folder: string) {
    let relativeFolder = posix.relative(this.opts.project.cwd, folder);

    if (!relativeFolder.match(/^\.{0,2}\//))
      relativeFolder = `./${relativeFolder}`;

    return relativeFolder.replace(/\/?$/, '/');
  }

  private async getBuildScripts(fetchResult: FetchResult) {
    const buildScripts = [];
    const {scripts} = await Manifest.find(fetchResult.prefixPath, {baseFs: fetchResult.packageFs});

    for (const scriptName of [`preinstall`, `install`, `postinstall`])
      if (scripts.has(scriptName))
        buildScripts.push(scriptName);
    
    return buildScripts;
  }

  private getUnpluggedPath(locator: Locator) {
    return posix.resolve(this.opts.project.configuration.get(`pnpUnpluggedFolder`), structUtils.slugifyLocator(locator));
  }

  private async unplugPackage(locator: Locator, packageFs: FakeFS) {
    const unplugPath = this.getUnpluggedPath(locator);
    this.unpluggedPaths.add(unplugPath);

    const fs = new NodeFS();
    await fs.mkdirpPromise(unplugPath);
    await fs.copyPromise(unplugPath, `.`, {baseFs: packageFs, overwrite: false});

    return new CwdFS(unplugPath);
  }

  private isUnplugged(ident: Ident, dependencyMeta: DependencyMeta) {
    if (dependencyMeta.unplugged)
      return true;

    if (FORCED_UNPLUG_PACKAGES.has(ident.identHash))
      return true;

    return false;
  }
}
