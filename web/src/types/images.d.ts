// Docusaurus bundles image imports as URLs. Declare them for `tsc`.
declare module "*.png" {
  const src: string;
  export default src;
}
