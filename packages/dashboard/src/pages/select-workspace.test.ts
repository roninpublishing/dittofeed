import { IncomingMessage, ServerResponse } from "http";
import { Socket } from "net";
import { GetServerSidePropsContext } from "next";

import { getServerSideProps } from "./select-workspace.page";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const mockConfig = { authMode: "multi-tenant" };
const mockContext: {
  member: { id: string };
  memberRoles: { workspaceId: string }[];
} = {
  member: { id: memberId },
  memberRoles: [],
};
const mockWhere = jest.fn().mockResolvedValue(undefined);
const mockSet = jest.fn(() => ({ where: mockWhere }));
const mockUpdate = jest.fn(() => ({ set: mockSet }));

jest.mock("backend-lib/src/config", () => ({
  __esModule: true,
  default: () => mockConfig,
}));
jest.mock("backend-lib/src/db", () => ({
  db: () => ({ update: mockUpdate }),
}));
jest.mock("backend-lib/src/db/schema", () => ({
  workspaceMember: { id: "id" },
}));
jest.mock("backend-lib/src/logger", () => ({
  __esModule: true,
  default: () => ({ error: jest.fn() }),
}));
jest.mock("../lib/requestContext", () => ({
  requestContext:
    (handler: (context: unknown, auth: unknown) => unknown) =>
    (context: unknown) =>
      handler(context, mockContext),
}));

function selectWorkspace(id: string, redirectTo = "/workspace") {
  const req = Object.assign(new IncomingMessage(new Socket()), { cookies: {} });
  const context: GetServerSidePropsContext = {
    req,
    res: new ServerResponse(req),
    query: { workspaceId: id, redirectTo },
    resolvedUrl: "/select-workspace",
  };
  return getServerSideProps(context);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.authMode = "multi-tenant";
  mockContext.memberRoles = [];
});

describe("legacy workspace selection", () => {
  it("rejects a valid UUID without an authorized membership", async () => {
    await expect(selectWorkspace(workspaceId)).resolves.toEqual({
      notFound: true,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("persists an authorized option and keeps its requested destination", async () => {
    mockContext.memberRoles = [{ workspaceId }];
    await expect(selectWorkspace(workspaceId)).resolves.toEqual({
      redirect: { permanent: false, destination: "/workspace" },
    });
    expect(mockSet).toHaveBeenCalledWith({ lastWorkspaceId: workspaceId });
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });

  it("does not allow the legacy route to change a Google account selection", async () => {
    mockConfig.authMode = "google";
    mockContext.memberRoles = [{ workspaceId }];
    await expect(selectWorkspace(workspaceId)).resolves.toEqual({
      notFound: true,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
