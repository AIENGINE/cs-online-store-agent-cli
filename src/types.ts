export type ChunkType = 'content' | 'tool_call' | 'done';

export interface ParsedChunk {
    type: ChunkType;
    content?: string;
    toolCall?: {
        index: number;
        id: string;
        name: string;
        arguments: any;
    };
}

export interface Env {
    LANGBASE_ONLINE_STORE_CUSTOMER_SERVICE_API_KEY: string;
    LANGBASE_SPORTS_PIPE_API_KEY: string;
    LANGBASE_ELECTRONICS_PIPE_API_KEY: string;
    LANGBASE_TRAVEL_PIPE_API_KEY: string;
}
