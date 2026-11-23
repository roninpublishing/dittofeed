import { Stack } from "@mui/material";
import { getPublisherForWorkspace } from "backend-lib/src/newsletters";
import { GetServerSideProps } from "next";

import DashboardContent from "../components/dashboardContent";
import PublicationManagement from "../components/publications/management";
import { addInitialStateToProps } from "../lib/addInitialStateToProps";
import { requestContext } from "../lib/requestContext";
import { PropsWithInitialState } from "../lib/types";

type Props = PropsWithInitialState<{
  publisherId: string | null;
  isPublisher: boolean;
}>;

export const getServerSideProps: GetServerSideProps<Props> = requestContext(
  async (_context, dfContext) => {
    const publisherId = await getPublisherForWorkspace(dfContext.workspace.id);
    return {
      props: addInitialStateToProps({
        dfContext,
        props: {
          publisherId,
          isPublisher: publisherId === dfContext.workspace.id,
        },
      }),
    };
  },
);

export default function Publications({ publisherId, isPublisher }: Props) {
  return (
    <DashboardContent publisherManagement={isPublisher}>
      <Stack
        spacing={3}
        sx={{
          p: { xs: 2, md: 4 },
          width: "100%",
          maxWidth: 1280,
          mx: "auto",
          overflowY: "auto",
        }}
      >
        <PublicationManagement publisherId={publisherId} />
      </Stack>
    </DashboardContent>
  );
}
