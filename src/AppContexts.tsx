import type { ComponentProps, ReactNode } from 'react';
import { NavigationContext } from './DocumentNavigator';
import { DocumentEditContext } from './DocumentEditContext';
export default function AppContexts({
  navigation,
  editing,
  children,
}: {
  navigation: ComponentProps<typeof NavigationContext.Provider>['value'];
  editing: ComponentProps<typeof DocumentEditContext.Provider>['value'];
  children: ReactNode;
}) {
  return (
    <NavigationContext.Provider value={navigation}>
      <DocumentEditContext.Provider value={editing}>{children}</DocumentEditContext.Provider>
    </NavigationContext.Provider>
  );
}
