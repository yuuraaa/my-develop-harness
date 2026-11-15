import { z } from "zod";
import { GitHubConfigError, repositoryNameSchema, type GitHubConfig } from "./github-config.js";
import { GitHubError, type GitHubClient } from "./github.js";

export type LabelCreateApi = Pick<GitHubClient, "getPages" | "update">;
export type LabelCreateResult = { name: string; status: "created" | "skipped" };
const labelSchema = z.object({ name: z.string() });

/** 明示コマンド専用。既存ラベルの更新・削除やIssueへの付与は行わない。 */
export async function createRepositoryLabels(api: LabelCreateApi, repository: string,
  labels: GitHubConfig["github"]["labels"], report: (result: LabelCreateResult) => void): Promise<void> {
  const parsed = repositoryNameSchema.safeParse(repository);
  if (!parsed.success) throw new GitHubConfigError();
  const endpoint = `/repos/${parsed.data}/labels`;
  const list = async () => {
    const result = z.array(labelSchema).safeParse(await api.getPages(`${endpoint}?per_page=100`));
    if (!result.success) throw new GitHubError("response");
    return result.data;
  };
  const existing = new Set((await list()).map(label => label.name.toLowerCase()));
  for (const name of Object.values(labels)) {
    const key = name.toLowerCase();
    if (existing.has(key)) { report({ name, status: "skipped" }); continue; }
    let status: LabelCreateResult["status"] = "created";
    try {
      const result = await api.update("POST", endpoint, { name, color: "ededed" }, async () => {
        const found = (await list()).find(label => label.name.toLowerCase() === key);
        return found ? { confirmed: true, value: found } : { confirmed: false };
      });
      const created = labelSchema.safeParse(result);
      if (!created.success || created.data.name.toLowerCase() !== key) throw new GitHubError("unknown");
    } catch (error) {
      // 同時実行で先に作成された場合のみスキップ。他の422を成功扱いしない。
      if (!(error instanceof GitHubError) || error.status !== 422) throw error;
      if (!(await list()).some(label => label.name.toLowerCase() === key)) throw error;
      status = "skipped";
    }
    existing.add(key);
    report({ name, status });
  }
}
