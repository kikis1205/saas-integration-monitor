import { createApp } from "./app";

const port = Number(process.env.PORT) || 3000;
const app = createApp();

app.listen(port, () => {
  console.info(`saas-integration-monitor listening on port ${port}`);
});
