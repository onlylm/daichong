import { Pool, type PoolClient } from "pg";

/**
 * 生产 PostgreSQL 仓储的事务边界。每个租户事务都使用 SET LOCAL，
 * 确保连接归还池后不会残留 merchant_id。完整 SQL 仓储将在下一阶段实现。
 */
export class PostgresTenantSession {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({connectionString, max: 20, ssl: connectionString.includes("localhost") ? false : {rejectUnauthorized: true}});
  }

  async withTenant<T>(merchantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.merchant_id', $1, true)", [merchantId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

