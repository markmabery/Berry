import {FakeFS, NodeFS}    from '@berry/zipfs';
import {posix}             from 'path';

import * as structUtils    from './structUtils';
import {IdentHash}         from './types';
import {Ident, Descriptor} from './types';

export interface WorkspaceDefinition {
  pattern: string;
};

export class Manifest {
  public name: Ident | null = null;
  public version: string | null = null;

  public bin: Map<string, string> = new Map();
  public scripts: Map<string, string> = new Map();

  public dependencies: Map<IdentHash, Descriptor> = new Map();
  public devDependencies: Map<IdentHash, Descriptor> = new Map();
  public peerDependencies: Map<IdentHash, Descriptor> = new Map();

  public workspaceDefinitions: Array<WorkspaceDefinition> = [];

  static async find(path: string, {baseFs = new NodeFS()}: {baseFs?: FakeFS} = {}) {
    return await Manifest.fromFile(posix.join(path, `package.json`), {baseFs});
  }

  static async fromFile(path: string, {baseFs = new NodeFS()}: {baseFs?: FakeFS} = {}) {
    const manifest = new Manifest();
    await manifest.loadFile(path, {baseFs});

    return manifest;
  }

  async loadFile(path: string, {baseFs = new NodeFS()}: {baseFs?: FakeFS}) {
    const content = await baseFs.readFilePromise(path, `utf8`);
    const data = JSON.parse(content);

    this.load(data);
  }

  load(data: any) {
    if (typeof data !== `object` || data === null)
      throw new Error(`Utterly invalid manifest data`);

    const errors: Array<Error> = [];

    if (typeof data.name === `string`) {
      try {
        this.name = structUtils.parseIdent(data.name);
      } catch (error) {
        errors.push(new Error(`Parsing failed for the 'name' field`));
      }
    }

    if (typeof data.bin === `string`) {
      if (this.name !== null) {
        this.bin = new Map([[structUtils.stringifyIdent(this.name), data.bin]]);
      } else {
        errors.push(new Error(`String bin field, but no attached package name`));
      }
    } else if (typeof data.bin === `object` && data.bin !== null) {
      for (const [key, value] of Object.entries(data.bin)) {
        if (typeof value !== `string`) {
          errors.push(new Error(`Invalid bin definition for '${key}'`));
          continue;
        }

        this.bin.set(key, value);
      }
    }

    if (typeof data.scripts === `object` && data.scripts !== null) {
      for (const [key, value] of Object.entries(data.scripts)) {
        if (typeof value !== `string`) {
          errors.push(new Error(`Invalid script definition for '${key}'`));
          continue;
        }

        this.scripts.set(key, value);
      }
    }

    if (typeof data.dependencies === `object` && data.dependencies !== null) {
      for (const [name, range] of Object.entries(data.dependencies)) {
        if (typeof range !== 'string') {
          errors.push(new Error(`Invalid dependency range for '${name}'`));
          continue;
        }

        let ident;
        try {
          ident = structUtils.parseIdent(name);
        } catch (error) {
          errors.push(new Error(`Parsing failed for the dependency name '${name}'`));
          continue;
        }

        const descriptor = structUtils.makeDescriptor(ident, range);
        this.dependencies.set(descriptor.identHash, descriptor);
      }
    }

    if (typeof data.devDependencies === `object` && data.devDependencies !== null) {
      for (const [name, range] of Object.entries(data.devDependencies)) {
        if (typeof range !== 'string') {
          errors.push(new Error(`Invalid dependency range for '${name}'`));
          continue;
        }

        let ident;
        try {
          ident = structUtils.parseIdent(name);
        } catch (error) {
          errors.push(new Error(`Parsing failed for the dependency name '${name}'`));
          continue;
        }

        const descriptor = structUtils.makeDescriptor(ident, range);
        this.devDependencies.set(descriptor.identHash, descriptor);
      }
    }

    if (typeof data.peerDependencies === `object` && data.peerDependencies !== null) {
      for (const [name, range] of Object.entries(data.peerDependencies)) {
        if (typeof range !== 'string') {
          errors.push(new Error(`Invalid dependency range for '${name}'`));
          continue;
        }

        let ident;
        try {
          ident = structUtils.parseIdent(name);
        } catch (error) {
          errors.push(new Error(`Parsing failed for the dependency name '${name}'`));
          continue;
        }

        const descriptor = structUtils.makeDescriptor(ident, range);
        this.peerDependencies.set(descriptor.identHash, descriptor);
      }
    }

    if (Array.isArray(data.workspaces)) {
      for (const entry of data.workspaces) {
        if (typeof entry !== `string`) {
          errors.push(new Error(`Invalid workspace definition for '${entry}'`));
          continue;
        }

        this.workspaceDefinitions.push({
          pattern: entry,
        });
      }
    }

    return errors;
  }

  exportTo(data: {[key: string]: any}) {
    data.dependencies = this.dependencies.size === 0 ? undefined : Object.assign({}, ... structUtils.sortDescriptors(this.dependencies.values()).map(dependency => {
      return {[structUtils.stringifyIdent(dependency)]: dependency.range};
    }));

    data.devDependencies = this.devDependencies.size === 0 ? undefined : Object.assign({}, ... structUtils.sortDescriptors(this.devDependencies.values()).map(dependency => {
      return {[structUtils.stringifyIdent(dependency)]: dependency.range};
    }));

    data.peerDependencies = this.peerDependencies.size === 0 ? undefined : Object.assign({}, ... structUtils.sortDescriptors(this.peerDependencies.values()).map(dependency => {
      return {[structUtils.stringifyIdent(dependency)]: dependency.range};
    }));
  }
};
