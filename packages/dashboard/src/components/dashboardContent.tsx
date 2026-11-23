import dynamic from "next/dynamic";

import DashboardHead from "./dashboardHead";
import MainLayout from "./mainLayout";

const CommandPalette = dynamic(() => import("./commandPalette"), {
  ssr: false,
});

export default function DashboardContent({
  children,
  publisherManagement = false,
}: {
  children?: React.ReactNode;
  publisherManagement?: boolean;
}) {
  return (
    <>
      <DashboardHead />
      <MainLayout publisherManagement={publisherManagement}>
        <>{children}</>
      </MainLayout>
      <CommandPalette />
    </>
  );
}
