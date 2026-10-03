// Static image imports resolve to a URL string at build time (Docusaurus webpack loader).
declare module "*.png" {
  const src: string;
  export default src;
}
