export type IdentHash = string & { __ident_hash: string };

export interface Ident {
  identHash: IdentHash,
  scope: string | null,
  name: string,
};

export type DescriptorHash = string & { __descriptor_hash: string };

export interface Descriptor extends Ident {
  descriptorHash: DescriptorHash,
  range: string,
};

export type LocatorHash = string & { __locator_hash: string };

export interface Locator extends Ident {
  locatorHash: LocatorHash,
  reference: string,
};

export interface Package extends Locator {
  dependencies: Map<DescriptorHash, Descriptor>,
  peerDependencies: Map<DescriptorHash, Descriptor>,
};
