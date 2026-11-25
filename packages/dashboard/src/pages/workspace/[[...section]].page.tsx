import { Alert, Button, Stack } from "@mui/material";
import { getPublisherForWorkspace } from "backend-lib/src/newsletters";
import { CompletionStatus } from "isomorphic-lib/src/types";
import { GetServerSideProps } from "next";
import ErrorPage from "next/error";
import { useRouter } from "next/router";

import DashboardContent from "../../components/dashboardContent";
import WorkspaceDashboard from "../../components/workspace/dashboard";
import { WorkspaceNavigationContext } from "../../components/workspace/navigation";
import { addInitialStateToProps } from "../../lib/addInitialStateToProps";
import { useAppStorePick } from "../../lib/appStore";
import { requestContext } from "../../lib/requestContext";
import { PropsWithInitialState } from "../../lib/types";
import { parseWorkspaceRoute, WorkspaceRoute } from "../../lib/workspaceRoutes";

type Props = PropsWithInitialState<{
  publisherId: string | null;
  isPublisher: boolean;
  route: WorkspaceRoute;
  workspaceId: string;
}>;

export const getServerSideProps: GetServerSideProps<Props> = requestContext(
  async (context, dfContext) => {
    const route = parseWorkspaceRoute(context.params?.section);
    if (!route) return { notFound: true };
    const publisherId = await getPublisherForWorkspace(dfContext.workspace.id);
    return {
      props: addInitialStateToProps({
        dfContext,
        props: {
          publisherId,
          isPublisher: publisherId === dfContext.workspace.id,
          route,
          workspaceId: dfContext.workspace.id,
        },
      }),
    };
  },
);

export default function WorkspacePage({
  publisherId,
  isPublisher,
  route: serverRoute,
  workspaceId,
}: Props) {
  const router = useRouter();
  const { workspace } = useAppStorePick(["workspace"]);
  const route = router.isReady
    ? parseWorkspaceRoute(router.query.section)
    : serverRoute;
  if (!route) return <ErrorPage statusCode={404} />;
  if (
    workspace.type !== CompletionStatus.Successful ||
    workspace.value.id !== workspaceId
  )
    return (
      <Alert
        severity="info"
        action={<Button onClick={() => router.reload()}>Reload</Button>}
      >
        Reload to open the current workspace.
      </Alert>
    );

  return (
    <WorkspaceNavigationContext.Provider value={workspaceId}>
      <DashboardContent publisherManagement={isPublisher}>
        <Stack
          spacing={2}
          sx={{
            p: { xs: 2, md: 3 },
            width: "100%",
            minWidth: 0,
            minHeight: 0,
            overflowY: "auto",
          }}
        >
          <WorkspaceDashboard
            key={workspaceId}
            publisherId={publisherId}
            route={route}
          />
        </Stack>
      </DashboardContent>
    </WorkspaceNavigationContext.Provider>
  );
}
