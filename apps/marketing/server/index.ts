import { capsule } from "lakebed/server";

// DinoRip marketing site. The landing page is fully client-rendered, so the
// capsule only needs an empty definition to satisfy the Lakebed runtime.
export default capsule({
  name: "dinorip",
  schema: {},
  queries: {},
  mutations: {}
});
