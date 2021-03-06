/* eslint-disable import/no-unresolved,no-unused-vars */
import { ObjectSchema } from '@hapi/joi';
import { AWSError } from 'aws-sdk';
import { DocumentClient } from 'aws-sdk/clients/dynamodb';
import { PromiseResult } from 'aws-sdk/lib/request';
import Query from './query';
import Scan from './scan';
import { IUpdateActions, buildUpdateActions } from './update-operators';
import ValidationError from './validation-error';
/* eslint-enable import/no-unresolved,no-unused-vars */

export type KeyValue = string | number | Buffer;
type SimpleKey = KeyValue;
type CompositeKey = { pk: KeyValue; sk: KeyValue };
type Keys = SimpleKey[] | CompositeKey[];

/* eslint-disable camelcase */

const isKey = (key: KeyValue | Object): key is KeyValue =>
  typeof key !== 'object' || key.constructor === Buffer;

const isComposite = (hashKeys_compositeKeys: Keys): hashKeys_compositeKeys is CompositeKey[] =>
  (hashKeys_compositeKeys[0] as any).pk !== undefined;

export default abstract class Model<T> {
  protected tableName: string;

  protected item: T;

  protected pk: string;

  protected sk: string;

  protected documentClient: DocumentClient;

  protected schema: ObjectSchema;

  constructor(item?: T) {
    this.item = item;
    if (!this.documentClient) {
      this.documentClient = new DocumentClient();
    }
  }

  public setItem(item: T): void {
    this.item = item;
  }

  public getItem(): T {
    return this.item;
  }

  /**
   * Create the item hold by the class. Prevent overwritting of an existing
   * item with the same key(s).
   * @param options Additional options supported by AWS document client put operation.
   */
  public async create(options?: Partial<DocumentClient.PutItemInput>): Promise<T>;

  /**
   * Create an item. Prevent overwritting of an existing item with the same key(s).
   * @param item The item to create
   * @param options Additional options supported by AWS document client put operation.
   */
  public async create(item: T, options?: Partial<DocumentClient.PutItemInput>): Promise<T>;

  public async create(
    item_options?: T | Partial<DocumentClient.PutItemInput>,
    options?: Partial<DocumentClient.PutItemInput>,
  ): Promise<T> {
    // Handle typescript method overloading
    const toCreate: T =
      item_options != null && this.isItem(item_options) ? item_options : this.item;
    const putOptions: Partial<DocumentClient.PutItemInput> =
      item_options != null && this.isItem(item_options) ? options : item_options;
    // Extract keys
    const pk = (toCreate as any)[this.pk];
    const sk = this.sk != null ? (toCreate as any)[this.sk] : null;
    // Prevent overwritting of existing item
    if (await this.exists(pk, sk)) {
      const error = new Error(
        `Item (hashkey=${pk}${sk != null ? `, rangekey= ${sk}` : ''}) already exists`,
      );
      error.name = 'EALREADYEXISTS';
      throw error;
    }
    // Save item
    return this.save(toCreate, putOptions);
  }

  private isItem(item: T | any): item is T {
    return item[this.pk] !== undefined;
  }

  /**
   * Save the item hold by the class. Overwrite of an existing item with the same key(s)
   * if it exists.
   * @param options Additional options supported by AWS document client put operation.
   */
  public async save(options?: Partial<DocumentClient.PutItemInput>): Promise<T>;

  /**
   * Save an item. Overwrite of an existing item with the same key(s) if it exists.
   * @param item The item to save
   * @param options Additional options supported by AWS document client put operation.
   */
  public async save(item: T, options?: Partial<DocumentClient.PutItemInput>): Promise<T>;

  public async save(
    item_options?: T | Partial<DocumentClient.PutItemInput>,
    options?: Partial<DocumentClient.PutItemInput>,
  ): Promise<T> {
    // Handle typescript method overloading
    const toSave: T = item_options != null && this.isItem(item_options) ? item_options : this.item;
    const putOptions: Partial<DocumentClient.PutItemInput> =
      item_options != null && this.isItem(item_options) ? options : item_options;
    // Validate item to put
    if (!toSave) {
      throw Error('No item to save');
    }
    if (this.schema) {
      const { error } = this.schema.validate(toSave);
      if (error) {
        throw new ValidationError('Validation error', error);
      }
    }
    // Prepare putItem operation
    const params: DocumentClient.PutItemInput = {
      TableName: this.tableName,
      Item: toSave,
    };
    // Overload putItem parameters with options given in arguments (if any)
    if (putOptions) {
      Object.assign(params, putOptions);
    }
    // Perform putItem operation
    await this.documentClient.put(params).promise();
    return toSave;
  }

  /**
   * Get a single item by hash key
   * @param pk : The hash key value
   * @param options : Additional options supported by AWS document client.
   * @returns The matching item
   */
  public async get(pk: KeyValue, options?: Partial<DocumentClient.GetItemInput>): Promise<T>;

  /**
   * Get a single item by hash key and range key
   * @param pk : The hash key value
   * @param sk  : The range key value, if the table has a composite key
   * @param options : Additional options supported by AWS document client.
   * @returns The matching item
   */
  public async get(
    pk: KeyValue,
    sk: KeyValue,
    options?: Partial<DocumentClient.GetItemInput>,
  ): Promise<T>;

  public async get(
    pk: any,
    sk_options?: Partial<DocumentClient.GetItemInput> | KeyValue,
    options?: Partial<DocumentClient.GetItemInput>,
  ): Promise<T> {
    // Handle method overloading
    const sk: KeyValue = sk_options != null && isKey(sk_options) ? sk_options : null;
    const getOptions = Model.getOptions(sk_options, options);
    // Prepare getItem operation
    this.testKeys(pk, sk);
    const params: DocumentClient.GetItemInput = {
      TableName: this.tableName,
      Key: this.buildKeys(pk, sk),
    };
    // Overload getItem parameters with options given in arguments (if any)
    if (options) {
      Object.assign(params, getOptions);
    }
    const result = await this.documentClient.get(params).promise();
    if (result && result.Item) {
      return result.Item as T;
    }
    return null;
  }

  private testKeys(pk: KeyValue, sk?: KeyValue) {
    if (!pk) {
      throw Error(`Missing HashKey ${this.pk}=${pk}`);
    }
    if (this.sk != null && !sk) {
      throw Error(`Missing RangeKey ${this.sk}=${sk}`);
    }
  }

  /**
   * Check if an item exist by keys
   * @param pk : The hash key value
   * @param options : Additional options supported by AWS document client.
   * @returns true if item exists, false otherwise
   */
  public async exists(
    pk: KeyValue,
    options?: Partial<DocumentClient.GetItemInput>,
  ): Promise<boolean>;

  /**
   * Check if an item exist by keys
   * @param pk : The hash key value
   * @param sk  : The range key value, if the table has a composite key
   * @param options : Additional options supported by AWS document client.
   * @returns true if item exists, false otherwise
   */
  public async exists(
    pk: KeyValue,
    sk: KeyValue,
    options?: Partial<DocumentClient.GetItemInput>,
  ): Promise<boolean>;

  public async exists(
    pk: KeyValue,
    sk_options?: any,
    options?: Partial<DocumentClient.GetItemInput>,
  ): Promise<boolean> {
    const req = await this.get(pk, sk_options, options);
    return req != null;
  }

  /**
   * Delete a single item by key
   * @param pk : The hash key value
   * @param options : Additional options supported by AWS document client.
   * @returns  The item as it was before deletion and consumed capacity
   */
  public async delete(
    pk: KeyValue,
    options?: Partial<DocumentClient.DeleteItemInput>,
  ): Promise<PromiseResult<DocumentClient.DeleteItemOutput, AWSError>>;

  public async delete(
    item: T,
    options?: Partial<DocumentClient.DeleteItemInput>,
  ): Promise<PromiseResult<DocumentClient.DeleteItemOutput, AWSError>>;
  /**
   * Delete a single item by key
   * @param pk : The hash key value
   * @param sk  : The range key value, if the table has a composite key
   * @param options : Additional options supported by AWS document client.
   * @returns  The item as it was before deletion and consumed capacity
   */

  public async delete(
    pk: KeyValue,
    sk: KeyValue,
    options?: Partial<DocumentClient.DeleteItemInput>,
  ): Promise<PromiseResult<DocumentClient.DeleteItemOutput, AWSError>>;

  public async delete(
    pk_item: KeyValue | T,
    sk_options?: KeyValue | Partial<DocumentClient.DeleteItemInput>,
    options?: Partial<DocumentClient.DeleteItemInput>,
  ): Promise<PromiseResult<DocumentClient.DeleteItemOutput, AWSError>> {
    // Handle method overloading
    if (!pk_item) {
      throw Error('Missing HashKey');
    }
    const pk = (pk_item as any)[this.pk] != null ? (pk_item as any)[this.pk] : pk_item;
    const sk: KeyValue = sk_options != null && isKey(sk_options) ? sk_options : null;
    const deleteOptions = Model.getOptions(sk_options, options);
    // Build delete item params
    this.testKeys(pk, sk);
    if (!(await this.exists(pk, sk))) {
      throw new Error('Item to delete does not exists');
    }
    const params: DocumentClient.DeleteItemInput = {
      TableName: this.tableName,
      Key: this.buildKeys(pk, sk),
    };
    if (options) {
      Object.assign(params, deleteOptions);
    }
    return this.documentClient.delete(params).promise();
  }

  /**
   * Perform a scan operation on the table
   * @param options : Additional options supported by AWS document client.
   * @returns  The scanned items (in the 1MB single scan operation limit) and the last evaluated key
   */
  public scan(options?: Partial<DocumentClient.ScanInput>): Scan<T> {
    // Building scan parameters
    const params: DocumentClient.ScanInput = {
      TableName: this.tableName,
    };
    if (options) {
      Object.assign(params, options);
    }
    return new Scan(this.documentClient, params, this.pk, this.sk);
  }

  /**
   * Count all item of the table
   * Careful ! All the table will be scanned. This might be time-consuming.
   * @returns the number of items in the table
   */
  public async count(): Promise<number> {
    return this.scan().count();
  }

  /**
   * Peform a query operation.
   * @param options The query options expected by AWS document client.
   * @returns The items matching the keys conditions, in the limit of 1MB,
   * and the last evaluated key.
   */
  public query(index?: string): Query<T>;

  public query(options?: Partial<DocumentClient.QueryInput>): Query<T>;

  public query(index?: string, options?: Partial<DocumentClient.QueryInput>): Query<T>;

  public query(
    index_options?: string | Partial<DocumentClient.QueryInput>,
    options?: Partial<DocumentClient.QueryInput>,
  ): Query<T> {
    // Handle overloading
    const indexName: string =
      index_options != null && typeof index_options === 'string' ? index_options : null;
    const queryOptions: Partial<DocumentClient.QueryInput> =
      index_options != null && typeof index_options === 'string'
        ? options
        : (index_options as Partial<DocumentClient.QueryInput>);
    // Building query
    const params: DocumentClient.QueryInput = {
      TableName: this.tableName,
    };
    if (indexName) {
      params.IndexName = indexName;
    }
    if (queryOptions) {
      Object.assign(params, queryOptions);
    }
    return new Query(this.documentClient, params, this.pk, this.sk);
  }

  /**
   * Perform a batch get operation in the limit of 100 items
   * @param keys : the keys of the items we want to retrieve
   * @param options : Additional options supported by AWS document client.
   * @returns the batch get operation result
   */
  private async getSingleBatch(
    keys: Keys,
    options?: Partial<DocumentClient.BatchGetItemInput>,
  ): Promise<T[]> {
    let params: DocumentClient.BatchGetItemInput;
    if (isComposite(keys)) {
      params = {
        RequestItems: {
          [this.tableName]: {
            Keys: keys.map((k) => this.buildKeys(k.pk, k.sk)),
          },
        },
      };
    } else {
      params = {
        RequestItems: {
          [this.tableName]: {
            Keys: keys.map((pk) => ({ [this.pk]: pk })),
          },
        },
      };
    }
    if (options) {
      Object.assign(params, options);
    }
    const result = await this.documentClient.batchGet(params).promise();
    return result.Responses[this.tableName] as T[];
  }

  /**
   * Perform a batch get operation beyond the limit of 100 items.
   * If the is more than 100 items, the keys are automatically split in batch of 100 that
   * are run in parallel.
   * @param keys : the keys of the items we want to retrieve
   * @param options : Additional options supported by AWS document client.
   * @returns all the matching items
   */
  public async batchGet(
    keys: Keys,
    options?: Partial<DocumentClient.BatchGetItemInput>,
  ): Promise<T[]> {
    if (keys.length === 0) {
      return [];
    }
    const splitBatch = (_keys: any[]) =>
      _keys.reduce((all, one, idx) => {
        const chunk = Math.floor(idx / 100);
        const currentBatches = all;
        currentBatches[chunk] = [].concat(all[chunk] || [], one);
        return currentBatches;
      }, []);
    if (isComposite(keys)) {
      // Split these IDs in batch of 100 as it is AWS DynamoDB batchGetItems operation limit
      const batches = splitBatch(keys);
      // Perform the batchGet operation for each batch
      const responsesBatches: T[][] = await Promise.all(
        batches.map((batch: CompositeKey[]) => this.getSingleBatch(batch, options)),
      );
      // Flatten batches of responses in array of users' data
      return responsesBatches.reduce((b1, b2) => b1.concat(b2), []);
    }
    // Split these IDs in batch of 100 as it is AWS DynamoDB batchGetItems operation limit
    const batches = splitBatch(keys);
    // Perform the batchGet operation for each batch
    const responsesBatches: T[][] = await Promise.all(
      batches.map((batch: KeyValue[]) => this.getSingleBatch(batch, options)),
    );
    // Flatten batches of responses in array of users' data
    return responsesBatches.reduce((b1, b2) => b1.concat(b2), []);
  }

  public async update(
    pk: KeyValue,
    actions: IUpdateActions,
    options?: Partial<DocumentClient.UpdateItemInput>,
  ): Promise<PromiseResult<DocumentClient.UpdateItemOutput, AWSError>>;

  public async update(
    pk: KeyValue,
    sk: KeyValue,
    actions: IUpdateActions,
    options?: Partial<DocumentClient.UpdateItemInput>,
  ): Promise<PromiseResult<DocumentClient.UpdateItemOutput, AWSError>>;

  public async update(
    pk: KeyValue,
    sk_actions: KeyValue | IUpdateActions,
    actions_options?: IUpdateActions | Partial<DocumentClient.UpdateItemInput>,
    options?: Partial<DocumentClient.UpdateItemInput>,
  ): Promise<PromiseResult<DocumentClient.UpdateItemOutput, AWSError>> {
    // Handle overloading
    let sk: KeyValue;
    let updateActions: IUpdateActions;
    let nativeOptions: Partial<DocumentClient.UpdateItemInput>;
    if (!isKey(sk_actions)) {
      // 1st overload
      sk = null;
      updateActions = sk_actions;
      nativeOptions = actions_options;
    } else {
      // 2nd iverload
      sk = sk_actions;
      updateActions = actions_options as IUpdateActions;
      nativeOptions = options;
    }
    this.testKeys(pk, sk);
    const params: DocumentClient.UpdateItemInput = {
      TableName: this.tableName,
      Key: this.buildKeys(pk, sk),
      AttributeUpdates: buildUpdateActions(updateActions),
    };
    if (nativeOptions) {
      Object.assign(params, nativeOptions);
    }
    return this.documentClient.update(params).promise();
  }

  private buildKeys(pk: any, sk?: any): DocumentClient.Key {
    const keys: DocumentClient.Key = {
      [this.pk]: pk,
    };
    if (this.sk) {
      keys[this.sk] = sk;
    }
    return keys;
  }

  private static getOptions(
    sk_options: KeyValue | Partial<DocumentClient.GetItemInput>,
    options: Partial<DocumentClient.GetItemInput>,
  ): Partial<DocumentClient.GetItemInput> {
    return sk_options != null && isKey(sk_options)
      ? options
      : (sk_options as Partial<DocumentClient.GetItemInput>);
  }
}
